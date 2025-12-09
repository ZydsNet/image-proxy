// ============================================
// Cloudflare Worker 图片代理 - 完整增强版
// 版本: 7.0.0 - KV配置 + 访问统计
// 功能: WebP转换 + API密钥验证 + 实时统计
// ============================================

// 🔧 默认配置（KV未配置时的回退值）
const DEFAULT_CONFIG = {
    // 目标网站
    TARGET_SITE: 'https://www.2ppt.com',
    
    // 图片转换
    ENABLE_WEBP: true,
    WEBP_QUALITY: 85,
    AVIF_ENABLE: false,
    AVIF_QUALITY: 75,
    
    // 安全设置
    API_KEYS_ENABLED: false,
    API_SECRET_KEYS: [],
    ALLOWED_DOMAINS: ['pic.haokj.cn', 'haokj.cn'],
    ALLOWED_REFERERS: [],
    
    // 性能配置
    CACHE_CDN_TTL: 604800,
    CACHE_BROWSER_TTL: 86400,
    CACHE_ERROR_TTL: 300,
    MAX_IMAGE_SIZE: 5 * 1024 * 1024,
    REQUEST_TIMEOUT: 10000,
    
    // 图片尺寸调整
    RESIZE_ENABLE: false,
    MAX_RESIZE_WIDTH: 1920,
    MAX_RESIZE_HEIGHT: 1080,
    
    // 🆕 统计配置
    ANALYTICS_ENABLED: true,
    ANALYTICS_RETENTION_DAYS: 30,
    ANALYTICS_SAMPLE_RATE: 1.0,
    
    // 管理员令牌（用于API访问）
    ADMIN_TOKEN: null
};

// 📦 配置管理器
class ConfigManager {
    constructor() {
        this.configCache = null;
        this.lastUpdated = 0;
        this.CACHE_TTL = 30000; // 配置缓存30秒
    }
    
    /**
     * 获取配置（带缓存）
     */
    async getConfig() {
        const now = Date.now();
        if (this.configCache && (now - this.lastUpdated) < this.CACHE_TTL) {
            return this.configCache;
        }
        
        try {
            const kvConfig = await this.loadFromKV();
            this.configCache = { ...DEFAULT_CONFIG, ...kvConfig };
            this.lastUpdated = now;
            return this.configCache;
            
        } catch (error) {
            console.warn('加载KV配置失败，使用默认配置:', error.message);
            return DEFAULT_CONFIG;
        }
    }
    
    /**
     * 从KV加载配置
     */
    async loadFromKV() {
        if (!CONFIG_STORE) {
            throw new Error('KV命名空间未绑定');
        }
        
        const configKeys = [
            'target_site', 'enable_webp', 'webp_quality', 'avif_enable', 'avif_quality',
            'api_keys_enabled', 'api_secret_keys', 'allowed_domains', 'allowed_referers',
            'cache_cdn_ttl', 'cache_browser_ttl', 'cache_error_ttl',
            'max_image_size', 'request_timeout', 'resize_enable',
            'max_resize_width', 'max_resize_height', 'analytics_enabled',
            'analytics_retention_days', 'analytics_sample_rate', 'admin_token'
        ];
        
        const config = {};
        const values = await Promise.all(
            configKeys.map(key => CONFIG_STORE.get(key))
        );
        
        configKeys.forEach((key, index) => {
            if (values[index] !== null) {
                config[key] = this.parseValue(key, values[index]);
            }
        });
        
        return this.normalizeConfig(config);
    }
    
    /**
     * 解析配置值
     */
    parseValue(key, value) {
        // 处理数组类型
        if (key.includes('keys') || key.includes('domains') || key.includes('referers')) {
            return value.split(',').map(item => item.trim()).filter(item => item);
        }
        
        // 处理布尔值
        if (key.startsWith('enable_') || key.includes('_enabled')) {
            return value.toLowerCase() === 'true';
        }
        
        // 处理数字
        if (key.includes('_ttl') || key.includes('_size') || 
            key.includes('_timeout') || key.includes('_quality') ||
            key.includes('_width') || key.includes('_height') ||
            key.includes('_days') || key.includes('_rate')) {
            const num = parseInt(value, 10);
            return isNaN(num) ? value : num;
        }
        
        // 默认返回字符串
        return value;
    }
    
    /**
     * 标准化配置格式
     */
    normalizeConfig(kvConfig) {
        const normalized = {};
        
        const mapping = {
            'target_site': 'TARGET_SITE',
            'enable_webp': 'ENABLE_WEBP',
            'webp_quality': 'WEBP_QUALITY',
            'avif_enable': 'AVIF_ENABLE',
            'avif_quality': 'AVIF_QUALITY',
            'api_keys_enabled': 'API_KEYS_ENABLED',
            'api_secret_keys': 'API_SECRET_KEYS',
            'allowed_domains': 'ALLOWED_DOMAINS',
            'allowed_referers': 'ALLOWED_REFERERS',
            'cache_cdn_ttl': 'CACHE_CDN_TTL',
            'cache_browser_ttl': 'CACHE_BROWSER_TTL',
            'cache_error_ttl': 'CACHE_ERROR_TTL',
            'max_image_size': 'MAX_IMAGE_SIZE',
            'request_timeout': 'REQUEST_TIMEOUT',
            'resize_enable': 'RESIZE_ENABLE',
            'max_resize_width': 'MAX_RESIZE_WIDTH',
            'max_resize_height': 'MAX_RESIZE_HEIGHT',
            'analytics_enabled': 'ANALYTICS_ENABLED',
            'analytics_retention_days': 'ANALYTICS_RETENTION_DAYS',
            'analytics_sample_rate': 'ANALYTICS_SAMPLE_RATE',
            'admin_token': 'ADMIN_TOKEN'
        };
        
        for (const [kvKey, configKey] of Object.entries(mapping)) {
            if (kvConfig[kvKey] !== undefined) {
                normalized[configKey] = kvConfig[kvKey];
            }
        }
        
        return normalized;
    }
}

// 📊 统计管理器
class AnalyticsManager {
    constructor() {
        this.batchSize = 10;
        this.batchQueue = [];
        this.flushInterval = 30000;
        this.isFlushing = false;
        this.statsCache = {};
        
        // 启动定时刷新
        setInterval(() => this.flushBatch(), this.flushInterval);
    }
    
    /**
     * 记录访问
     */
    async logRequest(event, request, response, extraData = {}) {
        const CONFIG = await new ConfigManager().getConfig();
        if (!CONFIG.ANALYTICS_ENABLED) return;
        
        // 采样控制
        if (Math.random() > CONFIG.ANALYTICS_SAMPLE_RATE) return;
        
        const url = new URL(request.url);
        const timestamp = Date.now();
        const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
        
        const record = {
            id: requestId,
            ts: timestamp,
            date: new Date(timestamp).toISOString().split('T')[0],
            hour: new Date(timestamp).getHours(),
            
            // 请求信息
            method: request.method,
            path: url.pathname,
            query: url.search.substring(0, 200),
            has_image_param: url.searchParams.has('url'),
            target_url: url.searchParams.get('url') ? 
                        new URL(url.searchParams.get('url')).hostname.substring(0, 50) : '',
            
            // 响应信息
            status: response.status,
            cache_status: response.headers.get('X-Proxy-Cache') || 'MISS',
            image_format: response.headers.get('X-Image-Format') || 'none',
            
            // 性能信息
            content_length: parseInt(response.headers.get('Content-Length') || '0'),
            proxy_version: response.headers.get('X-Proxy-Version') || '7.0.0',
            
            // 用户信息
            user_agent: (request.headers.get('User-Agent') || '').substring(0, 100),
            referer: request.headers.get('Referer') || 'direct',
            cf_ray: request.headers.get('CF-RAY') || '',
            cf_country: request.headers.get('CF-IPCountry') || 'XX',
            cf_region: request.headers.get('CF-Region') || '',
            
            // 额外数据
            ...extraData
        };
        
        // 添加到批处理队列
        this.batchQueue.push(record);
        
        // 达到批处理大小立即刷新
        if (this.batchQueue.length >= this.batchSize) {
            await this.flushBatch();
        }
        
        // 异步更新统计摘要
        if (event && event.waitUntil) {
            event.waitUntil(this.updateSummary(record));
        }
    }
    
    /**
     * 批量刷新到KV
     */
    async flushBatch() {
        if (this.isFlushing || this.batchQueue.length === 0) return;
        
        this.isFlushing = true;
        const batch = [...this.batchQueue];
        this.batchQueue = [];
        
        try {
            const CONFIG = await new ConfigManager().getConfig();
            const timestamp = Date.now();
            const batchId = `logs/${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
            
            await ANALYTICS_STORE.put(
                batchId,
                JSON.stringify({
                    logs: batch,
                    count: batch.length,
                    timestamp: timestamp
                }),
                { expirationTtl: CONFIG.ANALYTICS_RETENTION_DAYS * 86400 }
            );
            
            console.log(`📊 统计日志已保存: ${batchId} (${batch.length}条)`);
            
        } catch (error) {
            console.error('保存统计日志失败:', error);
            // 出错时保留数据
            this.batchQueue.push(...batch);
        } finally {
            this.isFlushing = false;
        }
    }
    
    /**
     * 更新实时统计摘要
     */
    async updateSummary(record) {
        try {
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
            const hourKey = `${dateStr}-${now.getHours().toString().padStart(2, '0')}`;
            
            const operations = [
                this.incrementCounter(`stats/hourly/${hourKey}/total`),
                this.incrementCounter(`stats/daily/${dateStr}/total`),
                this.incrementCounter(`stats/hourly/${hourKey}/status_${record.status}`),
                this.incrementCounter(`stats/hourly/${hourKey}/cache_${record.cache_status.toLowerCase()}`)
            ];
            
            if (record.cf_country !== 'XX') {
                operations.push(this.incrementCounter(`stats/daily/${dateStr}/country_${record.cf_country}`));
            }
            
            if (record.image_format !== 'none') {
                operations.push(this.incrementCounter(`stats/hourly/${hourKey}/format_${record.image_format}`));
            }
            
            if (record.content_length > 0) {
                operations.push(this.incrementCounter(`stats/hourly/${hourKey}/bandwidth`, record.content_length));
                operations.push(this.incrementCounter(`stats/daily/${dateStr}/bandwidth`, record.content_length));
            }
            
            await Promise.all(operations);
            
        } catch (error) {
            console.error('更新统计摘要失败:', error);
        }
    }
    
    /**
     * 原子递增计数器
     */
    async incrementCounter(key, increment = 1) {
        try {
            const CONFIG = await new ConfigManager().getConfig();
            const current = await ANALYTICS_STORE.get(key);
            const newValue = current ? parseInt(current) + increment : increment;
            
            await ANALYTICS_STORE.put(key, newValue.toString(), {
                expirationTtl: CONFIG.ANALYTICS_RETENTION_DAYS * 86400
            });
            
            // 更新缓存
            this.statsCache[key] = newValue;
            
        } catch (error) {
            console.error(`递增计数器 ${key} 失败:`, error);
        }
    }
    
    /**
     * 获取统计摘要
     */
    async getSummary(timeRange = 'today') {
        try {
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
            
            let keys = [];
            
            if (timeRange === 'today') {
                // 今天的数据
                keys.push(`stats/daily/${dateStr}/total`);
                keys.push(`stats/daily/${dateStr}/bandwidth`);
                
                // 今天每小时的数据
                for (let i = 0; i <= now.getHours(); i++) {
                    const hour = i.toString().padStart(2, '0');
                    keys.push(`stats/hourly/${dateStr}-${hour}/total`);
                    keys.push(`stats/hourly/${dateStr}-${hour}/cache_hit`);
                    keys.push(`stats/hourly/${dateStr}-${hour}/cache_miss`);
                    keys.push(`stats/hourly/${dateStr}-${hour}/bandwidth`);
                }
                
            } else if (timeRange === 'yesterday') {
                const yesterday = new Date(now);
                yesterday.setDate(yesterday.getDate() - 1);
                const yesterdayStr = `${yesterday.getFullYear()}-${(yesterday.getMonth()+1).toString().padStart(2, '0')}-${yesterday.getDate().toString().padStart(2, '0')}`;
                
                keys.push(`stats/daily/${yesterdayStr}/total`);
                keys.push(`stats/daily/${yesterdayStr}/bandwidth`);
                
            } else if (timeRange === 'week') {
                // 最近7天
                for (let i = 0; i < 7; i++) {
                    const date = new Date(now);
                    date.setDate(date.getDate() - i);
                    const dateKey = `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
                    keys.push(`stats/daily/${dateKey}/total`);
                    keys.push(`stats/daily/${dateKey}/bandwidth`);
                }
            }
            
            // 获取所有键的值
            const values = {};
            for (const key of keys) {
                // 先从缓存获取
                if (this.statsCache[key] !== undefined) {
                    values[key] = this.statsCache[key];
                } else {
                    const value = await ANALYTICS_STORE.get(key);
                    values[key] = value ? parseInt(value) : 0;
                    this.statsCache[key] = values[key];
                }
            }
            
            return this.formatSummary(values, timeRange);
            
        } catch (error) {
            console.error('获取统计摘要失败:', error);
            return null;
        }
    }
    
    /**
     * 格式化统计摘要
     */
    formatSummary(data, timeRange) {
        const summary = {
            total_requests: 0,
            total_bandwidth: 0,
            cache_hit_rate: 0,
            hourly_breakdown: [],
            daily_breakdown: [],
            status_codes: {},
            formats: {}
        };
        
        // 解析数据
        for (const [key, value] of Object.entries(data)) {
            if (key.includes('/total') && !key.includes('bandwidth')) {
                summary.total_requests += value;
                
                if (key.includes('hourly')) {
                    const hour = parseInt(key.split('-').pop().split('/')[0]);
                    summary.hourly_breakdown.push({ hour, count: value });
                }
                
                if (key.includes('daily') && key.includes('/total')) {
                    const date = key.split('/').pop();
                    summary.daily_breakdown.push({ date, count: value });
                }
            }
            
            if (key.includes('bandwidth')) {
                summary.total_bandwidth += value;
            }
            
            if (key.includes('status_')) {
                const status = key.split('_').pop();
                summary.status_codes[status] = (summary.status_codes[status] || 0) + value;
            }
            
            if (key.includes('format_')) {
                const format = key.split('_').pop();
                summary.formats[format] = (summary.formats[format] || 0) + value;
            }
            
            if (key.includes('cache_hit')) {
                const hit = value;
                const missKey = key.replace('hit', 'miss');
                const miss = data[missKey] || 0;
                const total = hit + miss;
                summary.cache_hit_rate = total > 0 ? (hit / total * 100).toFixed(2) : 0;
            }
        }
        
        // 排序
        summary.hourly_breakdown.sort((a, b) => a.hour - b.hour);
        summary.daily_breakdown.sort((a, b) => {
            const dateA = new Date(a.date.replace(/-/g, '-'));
            const dateB = new Date(b.date.replace(/-/g, '-'));
            return dateA - dateB;
        });
        
        // 格式化带宽
        summary.total_bandwidth_mb = (summary.total_bandwidth / 1024 / 1024).toFixed(2);
        summary.total_bandwidth_gb = (summary.total_bandwidth / 1024 / 1024 / 1024).toFixed(3);
        
        // 计算平均请求大小
        summary.avg_request_size = summary.total_requests > 0 
            ? (summary.total_bandwidth / summary.total_requests).toFixed(0)
            : 0;
        
        return summary;
    }
}

// 🛠️ 图片代理工具类
class ImageProxy {
    
    /**
     * 清理URL
     */
    static sanitizeUrl(url) {
        if (!url || typeof url !== 'string') return null;
        
        let cleaned = url.trim();
        cleaned = cleaned.replace(/\s+\d{3}\s*\(.*?\)/g, '');
        cleaned = cleaned.replace(/Error:.*$/i, '');
        cleaned = cleaned.replace(/Failed:.*$/i, '');
        
        try {
            cleaned = decodeURIComponent(cleaned);
        } catch {
            cleaned = cleaned.replace(/%20/g, ' ')
                            .replace(/%3A/g, ':')
                            .replace(/%2F/g, '/')
                            .replace(/%3F/g, '?')
                            .replace(/%3D/g, '=');
        }
        
        return cleaned;
    }
    
    /**
     * 验证URL
     */
    static async validateUrl(url) {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        try {
            const parsed = new URL(url);
            
            if (!parsed.protocol.startsWith('http')) {
                return { valid: false, reason: '仅支持HTTP/HTTPS协议' };
            }
            
            if (CONFIG.ALLOWED_DOMAINS.length > 0) {
                const hostname = parsed.hostname.toLowerCase();
                const isAllowed = CONFIG.ALLOWED_DOMAINS.some(domain => 
                    hostname === domain || hostname.endsWith('.' + domain)
                );
                
                if (!isAllowed) {
                    return { valid: false, reason: '域名不在白名单中' };
                }
            }
            
            return { valid: true, url: parsed.href };
            
        } catch (error) {
            return { valid: false, reason: '无效的URL格式' };
        }
    }
    
    /**
     * 验证API密钥
     */
    static async validateApiKey(request, searchParams) {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        if (!CONFIG.API_KEYS_ENABLED || CONFIG.API_SECRET_KEYS.length === 0) {
            return { valid: true, reason: 'disabled' };
        }
        
        let providedKey = null;
        
        // 从URL参数获取
        if (searchParams.has('key')) {
            providedKey = searchParams.get('key');
        }
        
        // 从请求头获取
        if (!providedKey) {
            const authHeader = request.headers.get('Authorization');
            if (authHeader && authHeader.startsWith('Bearer ')) {
                providedKey = authHeader.substring(7);
            }
        }
        
        if (!providedKey) {
            return { valid: false, reason: 'no-key', message: '缺少API密钥' };
        }
        
        const isValid = CONFIG.API_SECRET_KEYS.includes(providedKey);
        
        return {
            valid: isValid,
            reason: isValid ? 'valid' : 'invalid',
            message: isValid ? '密钥有效' : '无效的API密钥'
        };
    }
    
    /**
     * 验证调用者
     */
    static async validateReferer(request) {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        if (CONFIG.ALLOWED_REFERERS.length === 0) {
            return { allowed: true, reason: 'no-restriction' };
        }
        
        if (!request.headers.has('referer')) {
            return { allowed: true, reason: 'direct-access' };
        }
        
        const referer = request.headers.get('referer');
        
        try {
            const refererUrl = new URL(referer);
            const refererHost = refererUrl.hostname.toLowerCase();
            
            const isAllowed = CONFIG.ALLOWED_REFERERS.some(allowed => {
                try {
                    const allowedUrl = new URL(allowed);
                    return refererHost === allowedUrl.hostname.toLowerCase();
                } catch {
                    return refererHost === allowed.toLowerCase() || 
                           refererHost.endsWith('.' + allowed.toLowerCase());
                }
            });
            
            if (isAllowed) {
                return { allowed: true, referer: referer };
            } else {
                return { 
                    allowed: false, 
                    reason: 'referer-not-allowed',
                    referer: referer 
                };
            }
            
        } catch (error) {
            return { allowed: false, reason: 'invalid-referer-format' };
        }
    }
    
    /**
     * 构建请求头
     */
    static async buildHeaders() {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        return {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'image/webp,image/avif,image/apng,image/*,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Referer': CONFIG.TARGET_SITE + '/',
            'Origin': CONFIG.TARGET_SITE,
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'cross-site'
        };
    }
    
    /**
     * 检查浏览器支持格式
     */
    static supportsModernFormat(request) {
        const accept = request.headers.get('accept') || '';
        return {
            webp: accept.includes('image/webp'),
            avif: accept.includes('image/avif')
        };
    }
    
    /**
     * 获取图片
     */
    static async fetchImage(url, request, searchParams) {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
        
        try {
            const formatSupport = this.supportsModernFormat(request);
            const headers = await this.buildHeaders();
            
            const fetchOptions = {
                headers: headers,
                signal: controller.signal,
                cf: {
                    cacheTtl: CONFIG.CACHE_CDN_TTL,
                    cacheEverything: true,
                    polish: 'lossy'
                }
            };
            
            // 如果支持WebP且已启用，添加到CF参数
            if (CONFIG.ENABLE_WEBP && formatSupport.webp) {
                fetchOptions.cf.image = {
                    format: 'webp',
                    quality: CONFIG.WEBP_QUALITY
                };
            }
            
            // 动态调整尺寸
            if (CONFIG.RESIZE_ENABLE) {
                if (!fetchOptions.cf.image) fetchOptions.cf.image = {};
                
                if (searchParams.has('width')) {
                    const width = parseInt(searchParams.get('width'));
                    if (!isNaN(width) && width > 0) {
                        fetchOptions.cf.image.width = Math.min(width, CONFIG.MAX_RESIZE_WIDTH);
                    }
                }
                
                if (searchParams.has('height')) {
                    const height = parseInt(searchParams.get('height'));
                    if (!isNaN(height) && height > 0) {
                        fetchOptions.cf.image.height = Math.min(height, CONFIG.MAX_RESIZE_HEIGHT);
                    }
                }
            }
            
            const response = await fetch(url, fetchOptions);
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return response;
            
        } catch (error) {
            clearTimeout(timeoutId);
            
            if (error.name === 'AbortError') {
                throw new Error('请求超时');
            }
            throw error;
        }
    }
    
    /**
     * 处理图片响应
     */
    static async processResponse(response) {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const imageData = await response.arrayBuffer();
        
        if (imageData.byteLength > CONFIG.MAX_IMAGE_SIZE) {
            throw new Error(`图片大小超过限制 (${(imageData.byteLength / 1024 / 1024).toFixed(2)}MB)`);
        }
        
        return {
            data: imageData,
            contentType: contentType,
            size: imageData.byteLength,
            status: response.status,
            headers: response.headers
        };
    }
    
    /**
     * 创建代理响应
     */
    static async createResponse(imageInfo, cacheStatus = 'MISS', request) {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        const headers = new Headers(imageInfo.headers);
        const formatSupport = this.supportsModernFormat(request);
        
        // 缓存头
        headers.set('Cache-Control', 
            `public, max-age=${CONFIG.CACHE_BROWSER_TTL}, ` +
            `s-maxage=${CONFIG.CACHE_CDN_TTL}, ` +
            `stale-while-revalidate=${CONFIG.CACHE_ERROR_TTL}`
        );
        
        // CORS头
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        
        // 安全头
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('X-Frame-Options', 'DENY');
        
        // 调试信息
        headers.set('X-Proxy-Cache', cacheStatus);
        headers.set('X-Proxy-Version', '7.0.0');
        headers.set('X-Image-Size', imageInfo.size.toString());
        headers.set('X-Image-Size-MB', (imageInfo.size / 1024 / 1024).toFixed(2) + 'MB');
        headers.set('X-Content-Type', imageInfo.contentType);
        
        // 转换信息
        if (CONFIG.ENABLE_WEBP && formatSupport.webp) {
            headers.set('X-Image-Format', 'webp');
        } else if (CONFIG.AVIF_ENABLE && formatSupport.avif) {
            headers.set('X-Image-Format', 'avif');
        } else {
            headers.set('X-Image-Format', 'original');
        }
        
        // 配置信息
        headers.set('X-Config-WebP', CONFIG.ENABLE_WEBP.toString());
        headers.set('X-Config-API', CONFIG.API_KEYS_ENABLED.toString());
        headers.set('X-Config-Analytics', CONFIG.ANALYTICS_ENABLED.toString());
        
        // 清理不需要的源站头
        ['Set-Cookie', 'Server', 'Via', 'X-Powered-By'].forEach(header => headers.delete(header));
        
        return new Response(imageInfo.data, {
            status: imageInfo.status,
            headers: headers
        });
    }
    
    /**
     * 创建占位图片
     */
    static async createPlaceholder(message = '图片加载失败', status = 500) {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        const placeholder = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
        
        return new Response(Uint8Array.from(atob(placeholder), c => c.charCodeAt(0)), {
            status: status,
            headers: {
                'Content-Type': 'image/png',
                'Cache-Control': `public, max-age=${CONFIG.CACHE_ERROR_TTL}`,
                'Access-Control-Allow-Origin': '*',
                'X-Proxy-Error': 'placeholder',
                'X-Proxy-Message': message,
                'X-Proxy-Version': '7.0.0'
            }
        });
    }
}

// 🎯 主请求处理器
async function handleRequest(request, event) {
    const url = new URL(request.url);
    const path = url.pathname;
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    
    console.log(`[${requestId}] ${request.method} ${path}`);
    
    // ============ 特殊路由处理 ============
    
    // 📊 健康检查
    if (path === '/health' || path === '/status') {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        return new Response(JSON.stringify({
            status: 'healthy',
            version: '7.0.0',
            timestamp: new Date().toISOString(),
            config_source: 'kv',
            features: {
                webp: CONFIG.ENABLE_WEBP,
                api_protection: CONFIG.API_KEYS_ENABLED,
                analytics: CONFIG.ANALYTICS_ENABLED,
                cache_days: CONFIG.CACHE_CDN_TTL / 86400
            }
        }, null, 2), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache',
                'X-Request-ID': requestId
            }
        });
    }
    
    // 📈 统计面板（HTML）
    if (path === '/stats' || path === '/analytics') {
        return new Response(generateStatsPage(url.origin), {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=300'
            }
        });
    }
    
    // 📋 配置信息
    if (path === '/config' || path === '/info') {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        // 安全过滤敏感信息
        const safeConfig = { ...CONFIG };
        if (safeConfig.API_SECRET_KEYS) {
            safeConfig.API_SECRET_KEYS = ['***'];
        }
        if (safeConfig.ADMIN_TOKEN) {
            safeConfig.ADMIN_TOKEN = '***';
        }
        
        return new Response(JSON.stringify({
            service: '2PPT图片代理服务',
            version: '7.0.0',
            config: safeConfig,
            endpoints: {
                health: '/health',
                stats: '/stats',
                config_api: '/api/config',
                analytics_api: '/api/analytics',
                proxy: '/?url=IMAGE_URL'
            }
        }, null, 2), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    // 🛡️ CORS预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Max-Age': '86400',
                'X-Proxy-Version': '7.0.0'
            }
        });
    }
    
    // 🚫 只允许GET请求
    if (request.method !== 'GET') {
        return new Response(JSON.stringify({
            error: true,
            message: 'Method not allowed',
            allowed_methods: ['GET', 'OPTIONS']
        }), {
            status: 405,
            headers: {
                'Content-Type': 'application/json',
                'Allow': 'GET, OPTIONS'
            }
        });
    }
    
    // 🏠 根路径：帮助页面
    if (path === '/' && !url.searchParams.has('url')) {
        const helpHtml = generateHelpPage(url.origin);
        return new Response(helpHtml, {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=3600'
            }
        });
    }
    
    // 📈 统计API
    if (path.startsWith('/api/analytics')) {
        return await handleAnalyticsApi(request, url, requestId);
    }
    
    // 🔧 配置API
    if (path.startsWith('/api/config')) {
        return await handleConfigApi(request, url, requestId);
    }
    
    // ============ 图片代理请求 ============
    
    const startTime = Date.now();
    
    try {
        // 🔐 API密钥验证
        const apiKeyCheck = await ImageProxy.validateApiKey(request, url.searchParams);
        if (!apiKeyCheck.valid) {
            const configManager = new ConfigManager();
            const CONFIG = await configManager.getConfig();
            
            if (CONFIG.API_KEYS_ENABLED) {
                console.warn(`[${requestId}] API密钥验证失败: ${apiKeyCheck.message}`);
                return await ImageProxy.createPlaceholder(`访问被拒绝: ${apiKeyCheck.message}`, 403);
            }
        }
        
        // 🌐 Referer验证
        const refererCheck = await ImageProxy.validateReferer(request);
        if (!refererCheck.allowed) {
            console.warn(`[${requestId}] 域名验证失败: ${refererCheck.reason}`);
            return await ImageProxy.createPlaceholder('访问被拒绝: 仅限授权网站使用', 403);
        }
        
        const targetUrlParam = url.searchParams.get('url');
        
        if (!targetUrlParam) {
            return new Response(JSON.stringify({
                error: true,
                message: '缺少url参数',
                usage: `${url.origin}/?url=IMAGE_URL`,
                example: `${url.origin}/?url=https://pic.haokj.cn/pic/image.jpg`
            }, null, 2), {
                status: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache'
                }
            });
        }
        
        // 清理URL
        const cleanedUrl = ImageProxy.sanitizeUrl(targetUrlParam);
        if (!cleanedUrl) {
            throw new Error('URL格式无效');
        }
        
        // 验证URL
        const validation = await ImageProxy.validateUrl(cleanedUrl);
        if (!validation.valid) {
            throw new Error(validation.reason);
        }
        
        console.log(`[${requestId}] 代理图片: ${validation.url.substring(0, 100)}...`);
        
        // 检查缓存
        const cache = caches.default;
        const cacheKey = new Request(`https://proxy-cache/${btoa(validation.url + '|' + request.url)}`, request);
        
        let cachedResponse = await cache.match(cacheKey);
        let cacheStatus = 'MISS';
        
        if (cachedResponse) {
            console.log(`[${requestId}] 缓存命中`);
            cacheStatus = 'HIT';
            const response = new Response(cachedResponse.body, cachedResponse);
            response.headers.set('X-Proxy-Cache', 'HIT');
            response.headers.set('X-Request-ID', requestId);
            
            // 记录统计（异步）
            if (event && event.waitUntil) {
                const analytics = new AnalyticsManager();
                event.waitUntil(analytics.logRequest(event, request, response, {
                    request_type: 'image_cache_hit',
                    processing_time: Date.now() - startTime,
                    request_id: requestId
                }));
            }
            
            return response;
        }
        
        console.log(`[${requestId}] 缓存未命中，获取源站`);
        
        // 获取图片
        const imageResponse = await ImageProxy.fetchImage(validation.url, request, url.searchParams);
        
        // 处理图片
        const imageInfo = await ImageProxy.processResponse(imageResponse);
        
        // 创建响应
        const proxyResponse = await ImageProxy.createResponse(imageInfo, 'MISS', request);
        proxyResponse.headers.set('X-Request-ID', requestId);
        
        // 异步缓存
        if (event && event.waitUntil) {
            const cacheResponse = proxyResponse.clone();
            const configManager = new ConfigManager();
            const CONFIG = await configManager.getConfig();
            cacheResponse.headers.set('Cache-Control', `public, max-age=${CONFIG.CACHE_CDN_TTL}`);
            event.waitUntil(cache.put(cacheKey, cacheResponse));
        }
        
        const sizeMB = (imageInfo.size / 1024 / 1024).toFixed(2);
        console.log(`[${requestId}] 代理成功: ${sizeMB}MB (${Date.now() - startTime}ms)`);
        
        // 记录统计（异步）
        if (event && event.waitUntil) {
            const analytics = new AnalyticsManager();
            event.waitUntil(analytics.logRequest(event, request, proxyResponse, {
                request_type: 'image_proxy',
                processing_time: Date.now() - startTime,
                image_size: imageInfo.size,
                cache_status: 'MISS',
                request_id: requestId
            }));
        }
        
        return proxyResponse;
        
    } catch (error) {
        console.error(`[${requestId}] 代理失败:`, error.message);
        
        const errorMessage = error.message.includes('timeout') ? '请求超时' : 
                           error.message.includes('HTTP 4') ? '图片服务器错误' :
                           error.message.includes('HTTP 5') ? '服务器内部错误' :
                           '图片加载失败';
        
        const errorResponse = await ImageProxy.createPlaceholder(errorMessage);
        
        // 记录错误统计
        if (event && event.waitUntil) {
            const analytics = new AnalyticsManager();
            event.waitUntil(analytics.logRequest(event, request, errorResponse, {
                request_type: 'image_error',
                processing_time: Date.now() - startTime,
                error: error.message,
                request_id: requestId
            }));
        }
        
        return errorResponse;
    }
}

// 📈 统计API处理器
async function handleAnalyticsApi(request, url, requestId) {
    const path = url.pathname;
    
    // 验证权限
    const configManager = new ConfigManager();
    const CONFIG = await configManager.getConfig();
    const authToken = request.headers.get('X-Admin-Token');
    
    if (CONFIG.ADMIN_TOKEN && authToken !== CONFIG.ADMIN_TOKEN) {
        return new Response(JSON.stringify({
            error: true,
            message: '未授权访问',
            request_id: requestId
        }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    const analytics = new AnalyticsManager();
    
    // GET /api/analytics/summary - 获取统计摘要
    if (path === '/api/analytics/summary') {
        const timeRange = url.searchParams.get('range') || 'today';
        const summary = await analytics.getSummary(timeRange);
        
        return new Response(JSON.stringify({
            success: true,
            data: summary,
            meta: {
                time_range: timeRange,
                generated_at: new Date().toISOString(),
                request_id: requestId
            }
        }, null, 2), {
            headers: { 
                'Content-Type': 'application/json',
                'Cache-Control': 'max-age=60'
            }
        });
    }
    
    // GET /api/analytics/realtime - 实时统计
    if (path === '/api/analytics/realtime') {
        const now = new Date();
        const dateStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
        const currentHour = `${dateStr}-${now.getHours().toString().padStart(2, '0')}`;
        
        const stats = {
            current_hour: {
                requests: parseInt(await ANALYTICS_STORE.get(`stats/hourly/${currentHour}/total`)) || 0,
                bandwidth: parseInt(await ANALYTICS_STORE.get(`stats/hourly/${currentHour}/bandwidth`)) || 0,
                cache_hits: parseInt(await ANALYTICS_STORE.get(`stats/hourly/${currentHour}/cache_hit`)) || 0,
                cache_misses: parseInt(await ANALYTICS_STORE.get(`stats/hourly/${currentHour}/cache_miss`)) || 0
            },
            today: {
                requests: parseInt(await ANALYTICS_STORE.get(`stats/daily/${dateStr}/total`)) || 0,
                bandwidth: parseInt(await ANALYTICS_STORE.get(`stats/daily/${dateStr}/bandwidth`)) || 0
            },
            yesterday: {
                requests: 0,
                bandwidth: 0
            }
        };
        
        // 计算缓存命中率
        const totalHourly = stats.current_hour.cache_hits + stats.current_hour.cache_misses;
        stats.current_hour.cache_hit_rate = totalHourly > 0 
            ? (stats.current_hour.cache_hits / totalHourly * 100).toFixed(2)
            : 0;
        
        return new Response(JSON.stringify({
            success: true,
            data: stats,
            meta: {
                generated_at: new Date().toISOString(),
                request_id: requestId
            }
        }, null, 2), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    // 不支持的端点
    return new Response(JSON.stringify({
        error: true,
        message: '不支持的统计API端点',
        endpoints: [
            'GET /api/analytics/summary',
            'GET /api/analytics/realtime'
        ],
        request_id: requestId
    }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
    });
}

// 🔧 配置API处理器
async function handleConfigApi(request, url, requestId) {
    const path = url.pathname;
    const configManager = new ConfigManager();
    const CONFIG = await configManager.getConfig();
    
    // 验证权限
    const authToken = request.headers.get('X-Admin-Token');
    if (CONFIG.ADMIN_TOKEN && authToken !== CONFIG.ADMIN_TOKEN) {
        return new Response(JSON.stringify({
            error: true,
            message: '未授权访问',
            request_id: requestId
        }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    // GET /api/config - 获取配置
    if (path === '/api/config' && request.method === 'GET') {
        // 安全过滤
        const safeConfig = { ...CONFIG };
        if (safeConfig.API_SECRET_KEYS) {
            safeConfig.API_SECRET_KEYS = safeConfig.API_SECRET_KEYS.map(() => '***');
        }
        if (safeConfig.ADMIN_TOKEN) {
            safeConfig.ADMIN_TOKEN = '***';
        }
        
        return new Response(JSON.stringify({
            success: true,
            data: safeConfig,
            meta: {
                source: 'kv',
                cached: configManager.configCache !== null,
                request_id: requestId
            }
        }, null, 2), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    return new Response(JSON.stringify({
        error: true,
        message: '不支持的配置API端点',
        endpoints: ['GET /api/config'],
        request_id: requestId
    }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
    });
}

// 🎨 生成帮助页面
function generateHelpPage(baseUrl) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>2PPT 图片代理服务 v7.0.0</title>
    <style>
        :root {
            --primary: #4a6ee0;
            --secondary: #6b46c1;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
            --gray-100: #f8f9fa;
            --gray-800: #2d3748;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            min-height: 100vh;
            color: var(--gray-800);
            line-height: 1.6;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.1);
        }
        h1 {
            color: var(--primary);
            margin-bottom: 10px;
            font-size: 2.5em;
        }
        .badge {
            background: var(--success);
            color: white;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 0.9em;
            display: inline-block;
            margin-left: 10px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin: 30px 0;
        }
        .stat-card {
            background: var(--gray-100);
            padding: 25px;
            border-radius: 12px;
            text-align: center;
            border-left: 4px solid var(--primary);
        }
        .stat-value {
            font-size: 2.2em;
            font-weight: bold;
            color: var(--primary);
            margin-bottom: 5px;
        }
        .code-block {
            background: var(--gray-800);
            color: white;
            padding: 20px;
            border-radius: 12px;
            margin: 20px 0;
            overflow-x: auto;
            font-family: 'SFMono-Regular', Consolas, monospace;
        }
        .btn {
            display: inline-block;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            padding: 12px 30px;
            border-radius: 10px;
            text-decoration: none;
            margin: 10px 5px;
            font-weight: 500;
            transition: all 0.3s;
            border: none;
            cursor: pointer;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(74, 110, 224, 0.3);
        }
        .btn-secondary {
            background: var(--gray-100);
            color: var(--gray-800);
        }
        .feature-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px;
            margin: 30px 0;
        }
        .feature {
            background: var(--gray-100);
            padding: 25px;
            border-radius: 12px;
            border-left: 4px solid var(--primary);
        }
        .feature-icon {
            font-size: 2em;
            margin-bottom: 15px;
        }
        footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e2e8f0;
            text-align: center;
            color: #718096;
        }
        .warning {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 15px;
            margin: 20px 0;
            border-radius: 8px;
        }
        .info {
            background: #d1ecf1;
            border-left: 4px solid #17a2b8;
            padding: 15px;
            margin: 20px 0;
            border-radius: 8px;
        }
        .api-endpoints {
            background: #e8f4fd;
            padding: 20px;
            border-radius: 12px;
            margin: 20px 0;
        }
        .endpoint {
            margin: 10px 0;
            padding: 10px;
            background: white;
            border-radius: 8px;
            border-left: 3px solid var(--primary);
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 2PPT 图片代理服务 <span class="badge">v7.0.0</span></h1>
        <p style="color: #666; margin-bottom: 30px;">基于KV存储的高性能图片代理，支持WebP转换和访问统计</p>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value">7天</div>
                <div>CDN缓存</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">✅</div>
                <div>WebP自动转换</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">📊</div>
                <div>实时访问统计</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">⚡</div>
                <div>毫秒级响应</div>
            </div>
        </div>
        
        <div class="info">
            <h3>🎯 快速开始</h3>
            <a href="${baseUrl}/?url=https://pic.haokj.cn/pic/0c3ee9ac07b14a1ebee65975eea3b3dc.jpg" class="btn">测试图片代理</a>
            <a href="${baseUrl}/stats" class="btn">查看统计面板</a>
            <a href="${baseUrl}/health" class="btn">健康检查</a>
            <a href="${baseUrl}/config" class="btn">配置信息</a>
        </div>
        
        <h2>✨ 核心特性</h2>
        <div class="feature-grid">
            <div class="feature">
                <div class="feature-icon">⚡</div>
                <h3>智能缓存</h3>
                <p>7天CDN缓存，边缘网络加速，大幅提升加载速度</p>
            </div>
            <div class="feature">
                <div class="feature-icon">🎨</div>
                <h3>WebP自动转换</h3>
                <p>根据浏览器支持自动转换为WebP格式，减少60%文件大小</p>
            </div>
            <div class="feature">
                <div class="feature-icon">📊</div>
                <h3>访问统计</h3>
                <p>完整的访问统计、流量监控和性能分析</p>
            </div>
            <div class="feature">
                <div class="feature-icon">🔐</div>
                <h3>安全防护</h3>
                <p>API密钥验证、域名白名单、防盗链保护</p>
            </div>
            <div class="feature">
                <div class="feature-icon">🔄</div>
                <h3>KV配置存储</h3>
                <p>配置存储在KV中，实时生效无需重新部署</p>
            </div>
            <div class="feature">
                <div class="feature-icon">🌐</div>
                <h3>全球CDN</h3>
                <p>Cloudflare全球网络，自动选择最优节点</p>
            </div>
        </div>
        
        <h2>📖 使用方式</h2>
        <div class="code-block">
# 基础使用
GET ${baseUrl}/?url=https://pic.haokj.cn/pic/your-image.jpg

# 带尺寸调整（如果启用）
GET ${baseUrl}/?url=图片地址&width=800&height=600

# 带API密钥（如果启用）
GET ${baseUrl}/?url=图片地址&key=YOUR_API_KEY
        </div>
        
        <div class="api-endpoints">
            <h3>🔧 API 端点</h3>
            <div class="endpoint">
                <strong>GET /health</strong> - 健康检查
            </div>
            <div class="endpoint">
                <strong>GET /config</strong> - 查看配置信息
            </div>
            <div class="endpoint">
                <strong>GET /stats</strong> - 统计面板（HTML）
            </div>
            <div class="endpoint">
                <strong>GET /api/analytics/summary</strong> - 统计摘要（需要管理令牌）
            </div>
            <div class="endpoint">
                <strong>GET /api/analytics/realtime</strong> - 实时统计（需要管理令牌）
            </div>
        </div>
        
        <h2>🔧 WordPress 集成</h2>
        <p>在主题的 functions.php 中添加：</p>
        <div class="code-block">
// 自动代理所有 haokj.cn 图片
add_filter('the_content', function($content) {
    $proxy_url = '${baseUrl}';
    $api_key = 'YOUR_API_KEY'; // 如果启用了API密钥
    
    return preg_replace_callback(
        '/(https?:\\/\\/pic\\.haokj\\.cn\\/[^"\'\\s]+)/',
        function($matches) use ($proxy_url, $api_key) {
            return $proxy_url . '/?url=' . urlencode($matches[1]) . '&key=' . $api_key;
        },
        $content
    );
});
        </div>
        
        <h2>📊 响应头信息</h2>
        <div class="code-block">
X-Proxy-Cache: HIT/MISS          # 缓存状态
X-Proxy-Version: 7.0.0           # 版本号
X-Image-Format: webp/original    # 图片格式
X-Image-Size-MB: 0.85            # 图片大小
X-Config-WebP: true/false        # WebP配置状态
X-Config-API: true/false         # API配置状态
X-Config-Analytics: true/false   # 统计配置状态
        </div>
        
        <footer>
            <p>© ${new Date().getFullYear()} 2PPT 图片代理服务</p>
            <p style="margin-top: 10px; font-size: 0.9em;">
                基于 Cloudflare Workers + KV 构建 • 支持实时配置 • 完整访问统计
            </p>
        </footer>
    </div>
</body>
</html>`;
}

// 📊 生成统计页面
function generateStatsPage(baseUrl) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>图片代理统计面板</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f7fa;
            color: #333;
            line-height: 1.6;
            padding: 20px;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        header {
            background: white;
            padding: 30px;
            border-radius: 15px;
            margin-bottom: 30px;
            box-shadow: 0 5px 20px rgba(0,0,0,0.05);
        }
        h1 {
            color: #4a6ee0;
            margin-bottom: 10px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin: 30px 0;
        }
        .stat-card {
            background: white;
            padding: 25px;
            border-radius: 12px;
            text-align: center;
            box-shadow: 0 5px 15px rgba(0,0,0,0.05);
            border-top: 4px solid #4a6ee0;
        }
        .stat-value {
            font-size: 2.5em;
            font-weight: bold;
            color: #4a6ee0;
            margin-bottom: 5px;
        }
        .stat-label {
            color: #666;
            font-size: 0.9em;
        }
        .chart-container {
            background: white;
            padding: 30px;
            border-radius: 15px;
            margin: 30px 0;
            box-shadow: 0 5px 20px rgba(0,0,0,0.05);
        }
        .controls {
            background: white;
            padding: 20px;
            border-radius: 12px;
            margin-bottom: 20px;
            display: flex;
            gap: 15px;
            align-items: center;
            flex-wrap: wrap;
        }
        input, select, button {
            padding: 10px 15px;
            border: 1px solid #ddd;
            border-radius: 8px;
            font-size: 14px;
        }
        button {
            background: #4a6ee0;
            color: white;
            border: none;
            cursor: pointer;
            transition: background 0.3s;
        }
        button:hover {
            background: #3a5ed0;
        }
        .data-table {
            background: white;
            padding: 20px;
            border-radius: 12px;
            margin: 20px 0;
            overflow-x: auto;
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #eee;
        }
        th {
            background: #f8f9fa;
            font-weight: 600;
            color: #555;
        }
        .loading {
            text-align: center;
            padding: 50px;
            color: #666;
        }
        .error {
            background: #fee;
            color: #c00;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
            border-left: 4px solid #c00;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>📊 图片代理统计面板</h1>
            <p>实时监控图片代理服务的访问统计和性能数据</p>
        </header>
        
        <div class="controls">
            <input type="password" id="token" placeholder="输入管理令牌" style="flex: 1;">
            <select id="timeRange">
                <option value="today">今日统计</option>
                <option value="yesterday">昨日统计</option>
                <option value="week">最近7天</option>
            </select>
            <button onclick="loadStats()">加载统计</button>
            <button onclick="loadRealtime()" style="background: #10b981;">实时数据</button>
        </div>
        
        <div id="statsContainer">
            <div class="loading" id="loading">
                <p>🔍 请输入管理令牌并加载统计...</p>
                <p style="margin-top: 10px; font-size: 0.9em; color: #888;">
                    管理令牌需要在KV配置中设置 ADMIN_TOKEN
                </p>
            </div>
        </div>
    </div>
    
    <script>
        async function loadStats() {
            const token = document.getElementById('token').value;
            const timeRange = document.getElementById('timeRange').value;
            
            if (!token) {
                showError('请输入管理令牌');
                return;
            }
            
            showLoading('正在加载统计数据...');
            
            try {
                const response = await fetch('${baseUrl}/api/analytics/summary?range=' + timeRange, {
                    headers: { 'X-Admin-Token': token }
                });
                
                const data = await response.json();
                
                if (data.success) {
                    displayStats(data.data);
                } else {
                    showError('加载失败: ' + (data.message || '未知错误'));
                }
                
            } catch (error) {
                showError('请求失败: ' + error.message);
            }
        }
        
        async function loadRealtime() {
            const token = document.getElementById('token').value;
            
            if (!token) {
                showError('请输入管理令牌');
                return;
            }
            
            showLoading('正在加载实时数据...');
            
            try {
                const response = await fetch('${baseUrl}/api/analytics/realtime', {
                    headers: { 'X-Admin-Token': token }
                });
                
                const data = await response.json();
                
                if (data.success) {
                    displayRealtime(data.data);
                } else {
                    showError('加载失败: ' + (data.message || '未知错误'));
                }
                
            } catch (error) {
                showError('请求失败: ' + error.message);
            }
        }
        
        function displayStats(stats) {
            const container = document.getElementById('statsContainer');
            
            if (!stats) {
                container.innerHTML = '<div class="error">未获取到统计数据</div>';
                return;
            }
            
            container.innerHTML = \`
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value">\${stats.total_requests.toLocaleString()}</div>
                        <div class="stat-label">总请求数</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">\${stats.total_bandwidth_mb} MB</div>
                        <div class="stat-label">总流量</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">\${stats.cache_hit_rate}%</div>
                        <div class="stat-label">缓存命中率</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">\${stats.avg_request_size} B</div>
                        <div class="stat-label">平均请求大小</div>
                    </div>
                </div>
                
                <div class="chart-container">
                    <h3>📈 每小时请求分布</h3>
                    <div style="height: 300px; margin-top: 20px; background: #f8f9fa; border-radius: 8px; padding: 20px;">
                        <canvas id="hourlyChart"></canvas>
                    </div>
                </div>
                
                <div class="data-table">
                    <h3>📅 每日统计</h3>
                    <table>
                        <thead>
                            <tr>
                                <th>日期</th>
                                <th>请求数</th>
                                <th>带宽</th>
                            </tr>
                        </thead>
                        <tbody>
                            \${stats.daily_breakdown.map(day => \`
                                <tr>
                                    <td>\${day.date}</td>
                                    <td>\${day.count.toLocaleString()}</td>
                                    <td>\${((day.count * stats.avg_request_size) / 1024 / 1024).toFixed(2)} MB</td>
                                </tr>
                            \`).join('')}
                        </tbody>
                    </table>
                </div>
            \`;
            
            // 绘制图表
            drawHourlyChart(stats.hourly_breakdown);
        }
        
        function displayRealtime(data) {
            const container = document.getElementById('statsContainer');
            
            container.innerHTML = \`
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value">\${data.current_hour.requests.toLocaleString()}</div>
                        <div class="stat-label">本小时请求</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">\${(data.current_hour.bandwidth / 1024 / 1024).toFixed(2)} MB</div>
                        <div class="stat-label">本小时流量</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">\${data.current_hour.cache_hit_rate}%</div>
                        <div class="stat-label">缓存命中率</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">\${data.today.requests.toLocaleString()}</div>
                        <div class="stat-label">今日总请求</div>
                    </div>
                </div>
                
                <div class="data-table">
                    <h3>⏰ 本小时详细数据</h3>
                    <table>
                        <tr>
                            <td>缓存命中</td>
                            <td><strong>\${data.current_hour.cache_hits}</strong></td>
                        </tr>
                        <tr>
                            <td>缓存未命中</td>
                            <td><strong>\${data.current_hour.cache_misses}</strong></td>
                        </tr>
                        <tr>
                            <td>总请求</td>
                            <td><strong>\${data.current_hour.requests}</strong></td>
                        </tr>
                        <tr>
                            <td>总流量</td>
                            <td><strong>\${(data.current_hour.bandwidth / 1024 / 1024).toFixed(2)} MB</strong></td>
                        </tr>
                    </table>
                </div>
            \`;
        }
        
        function drawHourlyChart(hourlyData) {
            const canvas = document.getElementById('hourlyChart');
            if (!canvas) return;
            
            const ctx = canvas.getContext('2d');
            const hours = hourlyData.map(d => d.hour + ':00');
            const counts = hourlyData.map(d => d.count);
            
            // 简单的柱状图
            const maxCount = Math.max(...counts, 1);
            const barWidth = 30;
            const spacing = 10;
            
            canvas.width = (barWidth + spacing) * hours.length;
            canvas.height = 250;
            
            // 清空画布
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // 绘制柱状图
            hours.forEach((hour, index) => {
                const x = index * (barWidth + spacing) + spacing;
                const height = (counts[index] / maxCount) * 200;
                const y = canvas.height - height - 30;
                
                // 柱子
                ctx.fillStyle = '#4a6ee0';
                ctx.fillRect(x, y, barWidth, height);
                
                // 文字
                ctx.fillStyle = '#333';
                ctx.font = '12px Arial';
                ctx.textAlign = 'center';
                ctx.fillText(hour, x + barWidth/2, canvas.height - 10);
                ctx.fillText(counts[index].toString(), x + barWidth/2, y - 5);
            });
        }
        
        function showLoading(message) {
            const container = document.getElementById('statsContainer');
            container.innerHTML = \`<div class="loading">\${message}</div>\`;
        }
        
        function showError(message) {
            const container = document.getElementById('statsContainer');
            container.innerHTML = \`<div class="error">❌ \${message}</div>\`;
        }
        
        // 页面加载时检查URL中的令牌
        window.addEventListener('load', () => {
            const urlParams = new URLSearchParams(window.location.search);
            const token = urlParams.get('token');
            if (token) {
                document.getElementById('token').value = token;
                loadStats();
            }
        });
    </script>
</body>
</html>`;
}

// 🚀 Worker入口点
addEventListener('fetch', event => {
    try {
        event.respondWith(handleRequest(event.request, event));
    } catch (error) {
        console.error('Worker全局错误:', error);
        
        // 优雅降级
        const placeholder = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
        event.respondWith(new Response(Uint8Array.from(atob(placeholder), c => c.charCodeAt(0)), {
            headers: {
                'Content-Type': 'image/png',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*',
                'X-Proxy-Error': 'global-error',
                'X-Proxy-Version': '7.0.0'
            }
        }));
    }
});

// ⏰ 定时任务（统计清理）
addEventListener('scheduled', event => {
    event.waitUntil(handleScheduledEvent(event));
});

async function handleScheduledEvent(event) {
    console.log('执行定时任务:', event.cron);
    
    // 这里可以添加定时清理统计数据的逻辑
    // 例如：清理30天前的日志数据
}
