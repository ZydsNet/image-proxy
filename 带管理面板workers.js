// ============================================
// Cloudflare Worker 图片代理 - 完整版
// 版本: 8.0.0 - KV配置 + 统计 + 管理面板
// ============================================

// 🔧 默认配置
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
    
    // 统计配置
    ANALYTICS_ENABLED: true,
    ANALYTICS_RETENTION_DAYS: 30,
    ANALYTICS_SAMPLE_RATE: 1.0,
    
    // 管理员令牌
    ADMIN_TOKEN: null
};

// 📦 配置管理器
class ConfigManager {
    constructor() {
        this.configCache = null;
        this.lastUpdated = 0;
        this.CACHE_TTL = 30000;
    }
    
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
            console.warn('加载KV配置失败:', error.message);
            return DEFAULT_CONFIG;
        }
    }
    
    async loadFromKV() {
        if (!CONFIG_STORE) return {};
        
        const configKeys = [
            'target_site', 'enable_webp', 'webp_quality', 'avif_enable', 'avif_quality',
            'api_keys_enabled', 'api_secret_keys', 'allowed_domains', 'allowed_referers',
            'cache_cdn_ttl', 'cache_browser_ttl', 'cache_error_ttl',
            'max_image_size', 'request_timeout', 'resize_enable',
            'max_resize_width', 'max_resize_height', 'analytics_enabled',
            'analytics_retention_days', 'analytics_sample_rate', 'admin_token'
        ];
        
        const config = {};
        const promises = configKeys.map(key => CONFIG_STORE.get(key));
        const values = await Promise.all(promises);
        
        configKeys.forEach((key, index) => {
            if (values[index] !== null) {
                config[key] = this.parseValue(key, values[index]);
            }
        });
        
        return this.normalizeConfig(config);
    }
    
    parseValue(key, value) {
        if (key.includes('keys') || key.includes('domains') || key.includes('referers')) {
            return value.split(',').map(item => item.trim()).filter(item => item);
        }
        
        if (key.startsWith('enable_') || key.includes('_enabled')) {
            return value.toLowerCase() === 'true';
        }
        
        if (key.includes('_ttl') || key.includes('_size') || 
            key.includes('_timeout') || key.includes('_quality') ||
            key.includes('_width') || key.includes('_height') ||
            key.includes('_days') || key.includes('_rate')) {
            const num = parseInt(value, 10);
            return isNaN(num) ? value : num;
        }
        
        return value;
    }
    
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
    
    async updateConfig(updates) {
        try {
            const operations = [];
            
            for (const [configKey, value] of Object.entries(updates)) {
                const kvKey = this.toKvKey(configKey);
                const kvValue = this.toKvValue(configKey, value);
                
                if (kvValue !== null) {
                    operations.push(CONFIG_STORE.put(kvKey, kvValue));
                }
            }
            
            await Promise.all(operations);
            this.configCache = null;
            this.lastUpdated = 0;
            
            return { success: true, message: '配置更新成功' };
        } catch (error) {
            return { success: false, message: `配置更新失败: ${error.message}` };
        }
    }
    
    toKvKey(configKey) {
        return configKey.toLowerCase();
    }
    
    toKvValue(key, value) {
        if (value === undefined || value === null) return null;
        if (Array.isArray(value)) return value.join(',');
        return String(value);
    }
}

// 📊 统计管理器
class AnalyticsManager {
    constructor() {
        this.batchSize = 10;
        this.batchQueue = [];
        this.flushInterval = 30000;
        this.isFlushing = false;
        
        setInterval(() => this.flushBatch(), this.flushInterval);
    }
    
    async logRequest(event, request, response, extraData = {}) {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        if (!CONFIG.ANALYTICS_ENABLED) return;
        
        if (Math.random() > CONFIG.ANALYTICS_SAMPLE_RATE) return;
        
        const url = new URL(request.url);
        const timestamp = Date.now();
        
        const record = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
            ts: timestamp,
            date: new Date(timestamp).toISOString().split('T')[0],
            hour: new Date(timestamp).getHours(),
            method: request.method,
            path: url.pathname,
            query: url.search.substring(0, 200),
            has_image_param: url.searchParams.has('url'),
            target_url: url.searchParams.get('url') ? 
                       new URL(url.searchParams.get('url')).hostname.substring(0, 50) : '',
            status: response.status,
            cache_status: response.headers.get('X-Proxy-Cache') || 'MISS',
            image_format: response.headers.get('X-Image-Format') || 'none',
            content_length: parseInt(response.headers.get('Content-Length') || '0'),
            user_agent: (request.headers.get('User-Agent') || '').substring(0, 100),
            referer: request.headers.get('Referer') || 'direct',
            cf_ray: request.headers.get('CF-RAY') || '',
            cf_country: request.headers.get('CF-IPCountry') || 'XX',
            cf_region: request.headers.get('CF-Region') || '',
            ...extraData
        };
        
        this.batchQueue.push(record);
        if (this.batchQueue.length >= this.batchSize) {
            await this.flushBatch();
        }
        
        if (event && event.waitUntil) {
            event.waitUntil(this.updateSummary(record));
        }
    }
    
    async flushBatch() {
        if (this.isFlushing || this.batchQueue.length === 0) return;
        
        this.isFlushing = true;
        const batch = [...this.batchQueue];
        this.batchQueue = [];
        
        try {
            const configManager = new ConfigManager();
            const CONFIG = await configManager.getConfig();
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
            this.batchQueue.push(...batch);
        } finally {
            this.isFlushing = false;
        }
    }
    
    async updateSummary(record) {
        try {
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
            const hourKey = `${dateStr}-${now.getHours().toString().padStart(2, '0')}`;
            
            await Promise.all([
                this.incrementCounter(`stats/hourly/${hourKey}/total`),
                this.incrementCounter(`stats/daily/${dateStr}/total`),
                this.incrementCounter(`stats/hourly/${hourKey}/status_${record.status}`),
                this.incrementCounter(`stats/hourly/${hourKey}/cache_${record.cache_status.toLowerCase()}`),
                record.cf_country !== 'XX' && this.incrementCounter(`stats/daily/${dateStr}/country_${record.cf_country}`),
                record.image_format !== 'none' && this.incrementCounter(`stats/hourly/${hourKey}/format_${record.image_format}`),
                record.content_length > 0 && this.incrementCounter(`stats/hourly/${hourKey}/bandwidth`, record.content_length),
                record.content_length > 0 && this.incrementCounter(`stats/daily/${dateStr}/bandwidth`, record.content_length)
            ].filter(Boolean));
        } catch (error) {
            console.error('更新统计摘要失败:', error);
        }
    }
    
    async incrementCounter(key, increment = 1) {
        try {
            const configManager = new ConfigManager();
            const CONFIG = await configManager.getConfig();
            const current = await ANALYTICS_STORE.get(key);
            const newValue = current ? parseInt(current) + increment : increment;
            
            await ANALYTICS_STORE.put(key, newValue.toString(), {
                expirationTtl: CONFIG.ANALYTICS_RETENTION_DAYS * 86400
            });
        } catch (error) {
            console.error(`递增计数器 ${key} 失败:`, error);
        }
    }
    
    async getSummary(timeRange = 'today') {
        try {
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
            
            let keys = [];
            
            if (timeRange === 'today') {
                keys.push(`stats/daily/${dateStr}/total`);
                keys.push(`stats/daily/${dateStr}/bandwidth`);
                
                for (let i = 0; i <= now.getHours(); i++) {
                    const hour = i.toString().padStart(2, '0');
                    keys.push(`stats/hourly/${dateStr}-${hour}/total`);
                    keys.push(`stats/hourly/${dateStr}-${hour}/cache_hit`);
                    keys.push(`stats/hourly/${dateStr}-${hour}/cache_miss`);
                    keys.push(`stats/hourly/${dateStr}-${hour}/bandwidth`);
                }
            } else if (timeRange === 'week') {
                for (let i = 0; i < 7; i++) {
                    const date = new Date(now);
                    date.setDate(date.getDate() - i);
                    const dateKey = `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
                    keys.push(`stats/daily/${dateKey}/total`);
                    keys.push(`stats/daily/${dateKey}/bandwidth`);
                }
            }
            
            const values = {};
            for (const key of keys) {
                const value = await ANALYTICS_STORE.get(key);
                values[key] = value ? parseInt(value) : 0;
            }
            
            return this.formatSummary(values);
        } catch (error) {
            console.error('获取统计摘要失败:', error);
            return null;
        }
    }
    
    formatSummary(data) {
        const summary = {
            total_requests: 0,
            total_bandwidth: 0,
            cache_hit_rate: 0,
            hourly_breakdown: [],
            daily_breakdown: []
        };
        
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
            
            if (key.includes('cache_hit')) {
                const hit = value;
                const missKey = key.replace('hit', 'miss');
                const miss = data[missKey] || 0;
                const total = hit + miss;
                summary.cache_hit_rate = total > 0 ? (hit / total * 100).toFixed(2) : 0;
            }
        }
        
        summary.hourly_breakdown.sort((a, b) => a.hour - b.hour);
        summary.daily_breakdown.sort((a, b) => {
            const dateA = new Date(a.date.replace(/-/g, '-'));
            const dateB = new Date(b.date.replace(/-/g, '-'));
            return dateA - dateB;
        });
        
        summary.total_bandwidth_mb = (summary.total_bandwidth / 1024 / 1024).toFixed(2);
        summary.avg_request_size = summary.total_requests > 0 
            ? (summary.total_bandwidth / summary.total_requests).toFixed(0)
            : 0;
        
        return summary;
    }
}

// 🛠️ 图片代理工具类
class ImageProxy {
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
    
    static async validateApiKey(request, searchParams) {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        if (!CONFIG.API_KEYS_ENABLED || CONFIG.API_SECRET_KEYS.length === 0) {
            return { valid: true, reason: 'disabled' };
        }
        
        let providedKey = null;
        
        if (searchParams.has('key')) {
            providedKey = searchParams.get('key');
        }
        
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
    
    static supportsModernFormat(request) {
        const accept = request.headers.get('accept') || '';
        return {
            webp: accept.includes('image/webp'),
            avif: accept.includes('image/avif')
        };
    }
    
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
            
            if (CONFIG.ENABLE_WEBP && formatSupport.webp) {
                fetchOptions.cf.image = {
                    format: 'webp',
                    quality: CONFIG.WEBP_QUALITY
                };
            }
            
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
    
    static async createResponse(imageInfo, cacheStatus = 'MISS', request) {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        const headers = new Headers(imageInfo.headers);
        const formatSupport = this.supportsModernFormat(request);
        
        headers.set('Cache-Control', 
            `public, max-age=${CONFIG.CACHE_BROWSER_TTL}, ` +
            `s-maxage=${CONFIG.CACHE_CDN_TTL}, ` +
            `stale-while-revalidate=${CONFIG.CACHE_ERROR_TTL}`
        );
        
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('X-Frame-Options', 'DENY');
        
        headers.set('X-Proxy-Cache', cacheStatus);
        headers.set('X-Proxy-Version', '8.0.0');
        headers.set('X-Image-Size', imageInfo.size.toString());
        headers.set('X-Image-Size-MB', (imageInfo.size / 1024 / 1024).toFixed(2) + 'MB');
        headers.set('X-Content-Type', imageInfo.contentType);
        
        if (CONFIG.ENABLE_WEBP && formatSupport.webp) {
            headers.set('X-Image-Format', 'webp');
        } else if (CONFIG.AVIF_ENABLE && formatSupport.avif) {
            headers.set('X-Image-Format', 'avif');
        } else {
            headers.set('X-Image-Format', 'original');
        }
        
        headers.set('X-Config-WebP', CONFIG.ENABLE_WEBP.toString());
        headers.set('X-Config-API', CONFIG.API_KEYS_ENABLED.toString());
        headers.set('X-Config-Analytics', CONFIG.ANALYTICS_ENABLED.toString());
        
        ['Set-Cookie', 'Server', 'Via', 'X-Powered-By'].forEach(header => headers.delete(header));
        
        return new Response(imageInfo.data, {
            status: imageInfo.status,
            headers: headers
        });
    }
    
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
                'X-Proxy-Version': '8.0.0'
            }
        });
    }
}

// 🛡️ 管理员验证工具
class AdminAuth {
    static async verifyToken(request) {
        const url = new URL(request.url);
        
        // 1. 从URL参数获取
        let token = url.searchParams.get('admin_token');
        
        // 2. 从Cookie获取
        if (!token) {
            const cookieHeader = request.headers.get('Cookie');
            if (cookieHeader) {
                const cookies = {};
                cookieHeader.split(';').forEach(cookie => {
                    const [key, value] = cookie.trim().split('=');
                    if (key && value) cookies[key] = value;
                });
                token = cookies.admin_token;
            }
        }
        
        // 3. 从请求头获取
        if (!token) {
            token = request.headers.get('X-Admin-Token');
        }
        
        if (!token) {
            return { authenticated: false, reason: 'no-token' };
        }
        
        // 验证令牌
        const validToken = await CONFIG_STORE.get('admin_token');
        if (!validToken || token !== validToken) {
            return { authenticated: false, reason: 'invalid-token' };
        }
        
        return { authenticated: true, token: token };
    }
    
    static createLoginCookie(token, days = 7) {
        const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
        return `admin_token=${token}; Path=/; Expires=${expires}; HttpOnly; Secure; SameSite=Strict`;
    }
}

// 🎯 主请求处理器
async function handleRequest(request, event) {
    const url = new URL(request.url);
    const path = url.pathname;
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    
    console.log(`[${requestId}] ${request.method} ${path}`);
    
    // ============ 特殊路由处理 ============
    
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
    
    // 📊 健康检查
    if (path === '/health' || path === '/status') {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        return new Response(JSON.stringify({
            status: 'healthy',
            version: '8.0.0',
            timestamp: new Date().toISOString(),
            config: {
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
    
    // 🔧 配置信息
    if (path === '/config' || path === '/info') {
        const configManager = new ConfigManager();
        const CONFIG = await configManager.getConfig();
        
        const safeConfig = { ...CONFIG };
        if (safeConfig.API_SECRET_KEYS) safeConfig.API_SECRET_KEYS = ['***'];
        if (safeConfig.ADMIN_TOKEN) safeConfig.ADMIN_TOKEN = '***';
        
        return new Response(JSON.stringify({
            service: '图片代理服务',
            version: '8.0.0',
            config: safeConfig,
            endpoints: {
                health: '/health',
                stats: '/stats',
                admin: '/admin',
                proxy: '/?url=IMAGE_URL'
            }
        }, null, 2), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    // 📈 统计面板
    if (path === '/stats' || path === '/analytics') {
        const statsHtml = generateStatsPage(url.origin);
        return new Response(statsHtml, {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=300'
            }
        });
    }
    
    // 👑 管理面板
    if (path === '/admin' || path.startsWith('/admin/')) {
        return await handleAdminPanel(request, url, event);
    }
    
    // 🛡️ CORS预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Max-Age': '86400',
                'X-Proxy-Version': '8.0.0'
            }
        });
    }
    
    // 🚫 只允许GET请求（除了管理面板）
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
    
    // 📈 统计API
    if (path.startsWith('/api/analytics')) {
        return await handleAnalyticsApi(request, url, requestId);
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

// 👑 管理面板处理器
async function handleAdminPanel(request, url, event) {
    const auth = await AdminAuth.verifyToken(request);
    const path = url.pathname;
    
    // 管理登录页面
    if (path === '/admin/login' || (!auth.authenticated && path !== '/admin/setup')) {
        return new Response(generateAdminLoginPage(url.origin), {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache'
            }
        });
    }
    
    // 初始设置页面（第一次使用时）
    if (path === '/admin/setup') {
        const existingToken = await CONFIG_STORE.get('admin_token');
        if (existingToken) {
            return Response.redirect(`${url.origin}/admin/login`);
        }
        
        if (request.method === 'POST') {
            const formData = await request.formData();
            const adminPassword = formData.get('admin_password');
            
            if (!adminPassword) {
                return new Response('请设置管理员密码', { status: 400 });
            }
            
            // 生成令牌
            const token = Math.random().toString(36).substring(2) + 
                         Math.random().toString(36).substring(2);
            
            // 保存到KV
            await CONFIG_STORE.put('admin_token', token);
            await CONFIG_STORE.put('target_site', 'https://www.2ppt.com');
            await CONFIG_STORE.put('enable_webp', 'true');
            await CONFIG_STORE.put('allowed_domains', 'pic.haokj.cn,haokj.cn');
            await CONFIG_STORE.put('analytics_enabled', 'true');
            
            // 设置Cookie并重定向
            const headers = new Headers();
            headers.set('Location', `${url.origin}/admin`);
            headers.set('Set-Cookie', AdminAuth.createLoginCookie(token));
            
            return new Response(null, {
                status: 302,
                headers: headers
            });
        }
        
        return new Response(generateAdminSetupPage(url.origin), {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache'
            }
        });
    }
    
    // 验证失败重定向到登录
    if (!auth.authenticated) {
        return Response.redirect(`${url.origin}/admin/login`);
    }
    
    // 管理主页面
    if (path === '/admin') {
        return await handleAdminDashboard(request, url);
    }
    
    // 配置管理
    if (path === '/admin/config') {
        return await handleAdminConfig(request, url);
    }
    
    // 统计管理
    if (path === '/admin/analytics') {
        return await handleAdminAnalytics(request, url);
    }
    
    // 安全设置
    if (path === '/admin/security') {
        return await handleAdminSecurity(request, url);
    }
    
    // API管理
    if (path === '/admin/api') {
        return await handleAdminApi(request, url);
    }
    
    // 退出登录
    if (path === '/admin/logout') {
        const headers = new Headers();
        headers.set('Location', `${url.origin}/admin/login`);
        headers.set('Set-Cookie', 'admin_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly');
        
        return new Response(null, {
            status: 302,
            headers: headers
        });
    }
    
    return new Response('管理页面不存在', { status: 404 });
}

// 🔧 管理功能处理器
async function handleAdminDashboard(request, url) {
    const configManager = new ConfigManager();
    const CONFIG = await configManager.getConfig();
    const analytics = new AnalyticsManager();
    
    const summary = await analytics.getSummary('today');
    const recentStats = await getRecentStats();
    
    const html = generateAdminDashboard(url.origin, CONFIG, summary, recentStats);
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache'
        }
    });
}

async function handleAdminConfig(request, url) {
    const configManager = new ConfigManager();
    
    if (request.method === 'POST') {
        const formData = await request.formData();
        const updates = {};
        
        // 收集配置更新
        const configFields = [
            'target_site', 'enable_webp', 'webp_quality',
            'allowed_domains', 'max_image_size', 'request_timeout',
            'cache_cdn_ttl', 'analytics_enabled', 'analytics_retention_days'
        ];
        
        for (const field of configFields) {
            const value = formData.get(field);
            if (value !== null) {
                updates[field.toUpperCase()] = value;
            }
        }
        
        await configManager.updateConfig(updates);
        
        const headers = new Headers();
        headers.set('Location', `${url.origin}/admin/config?success=1`);
        return new Response(null, {
            status: 302,
            headers: headers
        });
    }
    
    const CONFIG = await configManager.getConfig();
    const html = generateAdminConfigPage(url.origin, CONFIG);
    
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache'
        }
    });
}

async function handleAdminSecurity(request, url) {
    const configManager = new ConfigManager();
    
    if (request.method === 'POST') {
        const formData = await request.formData();
        const updates = {};
        
        const apiEnabled = formData.get('api_keys_enabled');
        const apiKeys = formData.get('api_secret_keys');
        const allowedReferers = formData.get('allowed_referers');
        
        if (apiEnabled !== null) updates.API_KEYS_ENABLED = apiEnabled;
        if (apiKeys !== null) updates.API_SECRET_KEYS = apiKeys.split(',').map(k => k.trim());
        if (allowedReferers !== null) updates.ALLOWED_REFERERS = allowedReferers.split(',').map(r => r.trim());
        
        await configManager.updateConfig(updates);
        
        const headers = new Headers();
        headers.set('Location', `${url.origin}/admin/security?success=1`);
        return new Response(null, {
            status: 302,
            headers: headers
        });
    }
    
    const CONFIG = await configManager.getConfig();
    const html = generateAdminSecurityPage(url.origin, CONFIG);
    
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache'
        }
    });
}

async function handleAdminAnalytics(request, url) {
    const analytics = new AnalyticsManager();
    const timeRange = url.searchParams.get('range') || 'today';
    
    const summary = await analytics.getSummary(timeRange);
    const html = generateAdminAnalyticsPage(url.origin, summary, timeRange);
    
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache'
        }
    });
}

async function handleAdminApi(request, url) {
    const configManager = new ConfigManager();
    const CONFIG = await configManager.getConfig();
    
    // 生成新的API密钥
    if (request.method === 'POST' && url.searchParams.get('action') === 'generate_key') {
        const newKey = 'key_' + Math.random().toString(36).substring(2) + 
                      '_' + Date.now().toString(36);
        
        const currentKeys = CONFIG.API_SECRET_KEYS || [];
        currentKeys.push(newKey);
        
        await configManager.updateConfig({
            API_SECRET_KEYS: currentKeys,
            API_KEYS_ENABLED: true
        });
        
        const headers = new Headers();
        headers.set('Location', `${url.origin}/admin/api?new_key=${encodeURIComponent(newKey)}`);
        return new Response(null, {
            status: 302,
            headers: headers
        });
    }
    
    const html = generateAdminApiPage(url.origin, CONFIG);
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache'
        }
    });
}

async function getRecentStats() {
    try {
        const now = new Date();
        const stats = {
            hourly: {},
            today: {
                requests: 0,
                bandwidth: 0
            }
        };
        
        // 获取最近几小时的数据
        for (let i = 0; i < 6; i++) {
            const date = new Date(now);
            date.setHours(date.getHours() - i);
            const hourKey = `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}-${date.getHours().toString().padStart(2, '0')}`;
            
            const requests = await ANALYTICS_STORE.get(`stats/hourly/${hourKey}/total`);
            const bandwidth = await ANALYTICS_STORE.get(`stats/hourly/${hourKey}/bandwidth`);
            
            stats.hourly[date.getHours()] = {
                requests: requests ? parseInt(requests) : 0,
                bandwidth: bandwidth ? parseInt(bandwidth) : 0
            };
        }
        
        const dateStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
        const todayRequests = await ANALYTICS_STORE.get(`stats/daily/${dateStr}/total`);
        const todayBandwidth = await ANALYTICS_STORE.get(`stats/daily/${dateStr}/bandwidth`);
        
        stats.today.requests = todayRequests ? parseInt(todayRequests) : 0;
        stats.today.bandwidth = todayBandwidth ? parseInt(todayBandwidth) : 0;
        
        return stats;
    } catch (error) {
        console.error('获取最近统计失败:', error);
        return null;
    }
}

// 📈 统计API处理器
async function handleAnalyticsApi(request, url, requestId) {
    const auth = await AdminAuth.verifyToken(request);
    
    if (!auth.authenticated) {
        return new Response(JSON.stringify({
            error: true,
            message: '未授权访问',
            request_id: requestId
        }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    const path = url.pathname;
    const analytics = new AnalyticsManager();
    
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
    
    return new Response(JSON.stringify({
        error: true,
        message: '不支持的统计API端点',
        request_id: requestId
    }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
    });
}

// 🎨 页面生成函数
function generateHelpPage(baseUrl) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>资源大师网图片代理服务 v8.0.0</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #4a6ee0, #6b46c1); color: white; padding: 40px; border-radius: 15px; margin-bottom: 30px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 30px 0; }
        .stat { background: #f8f9fa; padding: 20px; border-radius: 10px; text-align: center; }
        .btn { background: #4a6ee0; color: white; padding: 12px 25px; border-radius: 8px; text-decoration: none; display: inline-block; margin: 5px; }
        .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin: 30px 0; }
        .feature { background: #f8f9fa; padding: 25px; border-radius: 10px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🚀 资源大师网图片代理服务 v8.0.0</h1>
        <p>高性能图片代理，支持WebP转换、访问统计和管理面板</p>
        <a href="${baseUrl}/admin" class="btn">管理面板</a>
        <a href="${baseUrl}/?url=https://pic.haokj.cn/pic/0c3ee9ac07b14a1ebee65975eea3b3dc.jpg" class="btn">测试图片</a>
    </div>
    
    <div class="stats">
        <div class="stat">
            <h3>⚡</h3>
            <p>WebP自动转换</p>
        </div>
        <div class="stat">
            <h3>📊</h3>
            <p>实时访问统计</p>
        </div>
        <div class="stat">
            <h3>🔐</h3>
            <p>安全管理面板</p>
        </div>
        <div class="stat">
            <h3>🔄</h3>
            <p>KV配置存储</p>
        </div>
    </div>
    
    <h2>✨ 核心特性</h2>
    <div class="feature-grid">
        <div class="feature">
            <h3>🎨 WebP智能转换</h3>
            <p>根据浏览器支持自动转换为WebP格式，减少60%文件大小</p>
        </div>
        <div class="feature">
            <h3>📊 完整访问统计</h3>
            <p>实时统计请求数、流量、缓存命中率和地理位置</p>
        </div>
        <div class="feature">
            <h3>🔐 Web管理面板</h3>
            <p>通过浏览器管理所有配置，无需编辑代码</p>
        </div>
        <div class="feature">
            <h3>⚡ 智能缓存</h3>
            <p>7天CDN缓存，边缘网络加速</p>
        </div>
    </div>
    
    <h2>📖 使用方式</h2>
    <pre style="background: #f8f9fa; padding: 20px; border-radius: 10px;">
${baseUrl}/?url=https://pic.haokj.cn/pic/image.jpg
    </pre>
    
    <h2>🔧 管理功能</h2>
    <p>访问 <a href="${baseUrl}/admin">管理面板</a> 进行配置：</p>
    <ul>
        <li>📝 系统配置管理</li>
        <li>🔐 安全设置（API密钥、域名限制）</li>
        <li>📊 查看统计报表</li>
        <li>⚙️ 性能优化设置</li>
    </ul>
    
    <footer style="margin-top: 50px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666;">
        <p>© ${new Date().getFullYear()} 资源大师网图片代理服务 v8.0.0</p>
        <p>基于 Cloudflare Workers + KV 构建</p>
    </footer>
</body>
</html>`;
}

function generateAdminLoginPage(baseUrl) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>管理员登录 - 图片代理服务</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f7fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
        .login-box { background: white; padding: 40px; border-radius: 15px; box-shadow: 0 10px 40px rgba(0,0,0,0.1); width: 100%; max-width: 400px; }
        h2 { color: #4a6ee0; margin-bottom: 30px; text-align: center; }
        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; }
        button { width: 100%; padding: 12px; background: #4a6ee0; color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; margin-top: 10px; }
        .error { background: #fee; color: #c00; padding: 10px; border-radius: 5px; margin: 10px 0; }
    </style>
</head>
<body>
    <div class="login-box">
        <h2>🔐 管理员登录</h2>
        
        <form action="${baseUrl}/admin" method="get">
            <input type="password" name="admin_token" placeholder="输入管理令牌" required>
            <button type="submit">登录</button>
        </form>
        
        <div style="margin-top: 20px; text-align: center;">
            <a href="${baseUrl}/admin/setup" style="color: #666; text-decoration: none;">首次使用？点击这里初始化</a>
        </div>
    </div>
</body>
</html>`;
}

function generateAdminSetupPage(baseUrl) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>初始设置 - 图片代理服务</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f7fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
        .setup-box { background: white; padding: 40px; border-radius: 15px; box-shadow: 0 10px 40px rgba(0,0,0,0.1); width: 100%; max-width: 500px; }
        h2 { color: #4a6ee0; margin-bottom: 20px; }
        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; }
        button { width: 100%; padding: 12px; background: #4a6ee0; color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="setup-box">
        <h2>⚙️ 初始设置</h2>
        <p>这是第一次使用，请设置管理员密码：</p>
        
        <form action="${baseUrl}/admin/setup" method="post">
            <input type="password" name="admin_password" placeholder="设置管理员密码" required>
            <button type="submit">初始化系统</button>
        </form>
        
        <div style="margin-top: 20px; padding: 15px; background: #f0f7ff; border-radius: 8px;">
            <p style="margin: 0; color: #4a6ee0; font-size: 14px;">
                💡 系统将自动生成管理令牌并设置基本配置。初始化后请妥善保存管理令牌。
            </p>
        </div>
    </div>
</body>
</html>`;
}

function generateAdminDashboard(baseUrl, config, stats, recentStats) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>管理面板 - 图片代理服务</title>
    <style>
        :root {
            --primary: #4a6ee0;
            --secondary: #6b46c1;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
        }
        
        body { 
            font-family: -apple-system, BlinkMacSystemFont, sans-serif; 
            margin: 0; 
            background: #f5f7fa; 
            color: #333;
        }
        
        .sidebar {
            position: fixed;
            left: 0;
            top: 0;
            bottom: 0;
            width: 250px;
            background: white;
            box-shadow: 2px 0 10px rgba(0,0,0,0.1);
            padding: 20px;
        }
        
        .main-content {
            margin-left: 270px;
            padding: 30px;
        }
        
        .logo {
            color: var(--primary);
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 1px solid #eee;
        }
        
        .nav-item {
            display: block;
            padding: 12px 15px;
            margin: 5px 0;
            color: #666;
            text-decoration: none;
            border-radius: 8px;
            transition: all 0.3s;
        }
        
        .nav-item:hover, .nav-item.active {
            background: var(--primary);
            color: white;
        }
        
        .nav-item i {
            margin-right: 10px;
            width: 20px;
            text-align: center;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: white;
            padding: 25px;
            border-radius: 12px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.05);
            text-align: center;
            border-top: 4px solid var(--primary);
        }
        
        .stat-value {
            font-size: 2.5em;
            font-weight: bold;
            color: var(--primary);
            margin-bottom: 5px;
        }
        
        .stat-label {
            color: #666;
            font-size: 0.9em;
        }
        
        .card {
            background: white;
            padding: 25px;
            border-radius: 12px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.05);
            margin-bottom: 20px;
        }
        
        .btn {
            display: inline-block;
            background: var(--primary);
            color: white;
            padding: 10px 20px;
            border-radius: 8px;
            text-decoration: none;
            margin: 5px;
            border: none;
            cursor: pointer;
            font-size: 14px;
        }
        
        .btn-secondary {
            background: #f1f5f9;
            color: #475569;
        }
        
        .config-item {
            display: flex;
            justify-content: space-between;
            padding: 15px 0;
            border-bottom: 1px solid #f1f5f9;
        }
        
        .config-item:last-child {
            border-bottom: none;
        }
        
        .config-label {
            font-weight: 500;
        }
        
        .config-value {
            color: var(--primary);
            font-weight: bold;
        }
        
        .status-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 500;
        }
        
        .status-active {
            background: #d1fae5;
            color: #065f46;
        }
        
        .status-inactive {
            background: #fee2e2;
            color: #991b1b;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        
        th, td {
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #f1f5f9;
        }
        
        th {
            background: #f8fafc;
            font-weight: 600;
            color: #475569;
        }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="logo">🛡️ 管理面板</div>
        
        <a href="${baseUrl}/admin" class="nav-item active">
            📊 仪表板
        </a>
        <a href="${baseUrl}/admin/config" class="nav-item">
            ⚙️ 系统配置
        </a>
        <a href="${baseUrl}/admin/security" class="nav-item">
            🔐 安全设置
        </a>
        <a href="${baseUrl}/admin/analytics" class="nav-item">
            📈 访问统计
        </a>
        <a href="${baseUrl}/admin/api" class="nav-item">
            🔑 API管理
        </a>
        
        <div style="position: absolute; bottom: 30px; left: 20px; right: 20px;">
            <a href="${baseUrl}/" class="btn" style="width: 100%;">🏠 返回首页</a>
            <a href="${baseUrl}/admin/logout" class="btn btn-secondary" style="width: 100%; margin-top: 10px;">🚪 退出登录</a>
        </div>
    </div>
    
    <div class="main-content">
        <h1>📊 仪表板</h1>
        <p>图片代理服务的实时状态和统计信息</p>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value">${stats ? stats.total_requests.toLocaleString() : '0'}</div>
                <div class="stat-label">总请求数</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats ? stats.total_bandwidth_mb : '0'} MB</div>
                <div class="stat-label">总流量</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats ? stats.cache_hit_rate : '0'}%</div>
                <div class="stat-label">缓存命中率</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${config.ENABLE_WEBP ? '✅' : '❌'}</div>
                <div class="stat-label">WebP转换</div>
            </div>
        </div>
        
        <div class="card">
            <h2>⚡ 系统状态</h2>
            <div class="config-item">
                <span class="config-label">服务状态</span>
                <span class="config-value"><span class="status-badge status-active">运行正常</span></span>
            </div>
            <div class="config-item">
                <span class="config-label">WebP转换</span>
                <span class="config-value">
                    ${config.ENABLE_WEBP ? 
                        '<span class="status-badge status-active">已启用</span>' : 
                        '<span class="status-badge status-inactive">已禁用</span>'}
                </span>
            </div>
            <div class="config-item">
                <span class="config-label">API密钥保护</span>
                <span class="config-value">
                    ${config.API_KEYS_ENABLED ? 
                        '<span class="status-badge status-active">已启用</span>' : 
                        '<span class="status-badge status-inactive">已禁用</span>'}
                </span>
            </div>
            <div class="config-item">
                <span class="config-label">访问统计</span>
                <span class="config-value">
                    ${config.ANALYTICS_ENABLED ? 
                        '<span class="status-badge status-active">已启用</span>' : 
                        '<span class="status-badge status-inactive">已禁用</span>'}
                </span>
            </div>
        </div>
        
        <div class="card">
            <h2>🚀 快速操作</h2>
            <div>
                <a href="${baseUrl}/admin/config" class="btn">⚙️ 修改配置</a>
                <a href="${baseUrl}/admin/security" class="btn">🔐 安全设置</a>
                <a href="${baseUrl}/admin/analytics" class="btn">📈 查看统计</a>
                <a href="${baseUrl}/" class="btn">🏠 访问首页</a>
                <a href="${baseUrl}/?url=https://pic.haokj.cn/pic/0c3ee9ac07b14a1ebee65975eea3b3dc.jpg" class="btn">🖼️ 测试图片</a>
            </div>
        </div>
        
        ${recentStats ? `
        <div class="card">
            <h2>📊 最近6小时请求统计</h2>
            <table>
                <thead>
                    <tr>
                        <th>时间</th>
                        <th>请求数</th>
                        <th>流量</th>
                    </tr>
                </thead>
                <tbody>
                    ${Object.entries(recentStats.hourly).map(([hour, data]) => `
                        <tr>
                            <td>${hour}:00</td>
                            <td>${data.requests.toLocaleString()}</td>
                            <td>${(data.bandwidth / 1024 / 1024).toFixed(2)} MB</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        ` : ''}
    </div>
</body>
</html>`;
}

function generateAdminConfigPage(baseUrl, config) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>系统配置 - 管理面板</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #f5f7fa; color: #333; }
        .sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 250px; background: white; box-shadow: 2px 0 10px rgba(0,0,0,0.1); padding: 20px; }
        .main-content { margin-left: 270px; padding: 30px; }
        .logo { color: #4a6ee0; font-size: 24px; font-weight: bold; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
        .nav-item { display: block; padding: 12px 15px; margin: 5px 0; color: #666; text-decoration: none; border-radius: 8px; }
        .nav-item:hover, .nav-item.active { background: #4a6ee0; color: white; }
        .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 5px 15px rgba(0,0,0,0.05); margin-bottom: 20px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: 500; }
        input, select, textarea { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
        .btn { background: #4a6ee0; color: white; padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; }
        .config-value { color: #4a6ee0; font-weight: bold; margin-left: 10px; }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="logo">🛡️ 管理面板</div>
        <a href="${baseUrl}/admin" class="nav-item">📊 仪表板</a>
        <a href="${baseUrl}/admin/config" class="nav-item active">⚙️ 系统配置</a>
        <a href="${baseUrl}/admin/security" class="nav-item">🔐 安全设置</a>
        <a href="${baseUrl}/admin/analytics" class="nav-item">📈 访问统计</a>
        <a href="${baseUrl}/admin/api" class="nav-item">🔑 API管理</a>
        <div style="position: absolute; bottom: 30px; left: 20px; right: 20px;">
            <a href="${baseUrl}/admin/logout" class="btn" style="width: 100%;">🚪 退出登录</a>
        </div>
    </div>
    
    <div class="main-content">
        <h1>⚙️ 系统配置</h1>
        
        <form action="${baseUrl}/admin/config" method="post">
            <div class="card">
                <h2>🎯 基本配置</h2>
                <div class="form-group">
                    <label>目标网站</label>
                    <input type="text" name="target_site" value="${config.TARGET_SITE}" placeholder="https://www.2ppt.com">
                </div>
                <div class="form-group">
                    <label>允许的图片域名（逗号分隔）</label>
                    <textarea name="allowed_domains" rows="3">${config.ALLOWED_DOMAINS.join(',')}</textarea>
                </div>
            </div>
            
            <div class="card">
                <h2>🎨 图片优化</h2>
                <div class="form-group">
                    <label>启用WebP转换</label>
                    <select name="enable_webp">
                        <option value="true" ${config.ENABLE_WEBP ? 'selected' : ''}>启用</option>
                        <option value="false" ${!config.ENABLE_WEBP ? 'selected' : ''}>禁用</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>WebP质量 (1-100)</label>
                    <input type="number" name="webp_quality" value="${config.WEBP_QUALITY}" min="1" max="100">
                </div>
            </div>
            
            <div class="card">
                <h2>⚡ 性能设置</h2>
                <div class="form-group">
                    <label>CDN缓存时间（秒）</label>
                    <input type="number" name="cache_cdn_ttl" value="${config.CACHE_CDN_TTL}">
                    <small>7天 = 604800秒</small>
                </div>
                <div class="form-group">
                    <label>图片大小限制（字节）</label>
                    <input type="number" name="max_image_size" value="${config.MAX_IMAGE_SIZE}">
                    <small>5MB = 5242880字节</small>
                </div>
                <div class="form-group">
                    <label>请求超时时间（毫秒）</label>
                    <input type="number" name="request_timeout" value="${config.REQUEST_TIMEOUT}">
                </div>
            </div>
            
            <div class="card">
                <h2>📊 统计设置</h2>
                <div class="form-group">
                    <label>启用访问统计</label>
                    <select name="analytics_enabled">
                        <option value="true" ${config.ANALYTICS_ENABLED ? 'selected' : ''}>启用</option>
                        <option value="false" ${!config.ANALYTICS_ENABLED ? 'selected' : ''}>禁用</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>数据保留天数</label>
                    <input type="number" name="analytics_retention_days" value="${config.ANALYTICS_RETENTION_DAYS}">
                </div>
            </div>
            
            <button type="submit" class="btn" style="padding: 15px 30px; font-size: 16px;">💾 保存配置</button>
        </form>
    </div>
</body>
</html>`;
}

function generateAdminSecurityPage(baseUrl, config) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>安全设置 - 管理面板</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #f5f7fa; color: #333; }
        .sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 250px; background: white; box-shadow: 2px 0 10px rgba(0,0,0,0.1); padding: 20px; }
        .main-content { margin-left: 270px; padding: 30px; }
        .logo { color: #4a6ee0; font-size: 24px; font-weight: bold; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
        .nav-item { display: block; padding: 12px 15px; margin: 5px 0; color: #666; text-decoration: none; border-radius: 8px; }
        .nav-item:hover, .nav-item.active { background: #4a6ee0; color: white; }
        .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 5px 15px rgba(0,0,0,0.05); margin-bottom: 20px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: 500; }
        input, select, textarea { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
        .btn { background: #4a6ee0; color: white; padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; }
        .warning { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 8px; }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="logo">🛡️ 管理面板</div>
        <a href="${baseUrl}/admin" class="nav-item">📊 仪表板</a>
        <a href="${baseUrl}/admin/config" class="nav-item">⚙️ 系统配置</a>
        <a href="${baseUrl}/admin/security" class="nav-item active">🔐 安全设置</a>
        <a href="${baseUrl}/admin/analytics" class="nav-item">📈 访问统计</a>
        <a href="${baseUrl}/admin/api" class="nav-item">🔑 API管理</a>
        <div style="position: absolute; bottom: 30px; left: 20px; right: 20px;">
            <a href="${baseUrl}/admin/logout" class="btn" style="width: 100%;">🚪 退出登录</a>
        </div>
    </div>
    
    <div class="main-content">
        <h1>🔐 安全设置</h1>
        
        <div class="warning">
            <strong>⚠️ 安全提示：</strong> 启用API密钥验证后，所有图片请求都需要提供有效的API密钥。
        </div>
        
        <form action="${baseUrl}/admin/security" method="post">
            <div class="card">
                <h2>🔑 API密钥验证</h2>
                <div class="form-group">
                    <label>启用API密钥验证</label>
                    <select name="api_keys_enabled">
                        <option value="true" ${config.API_KEYS_ENABLED ? 'selected' : ''}>启用</option>
                        <option value="false" ${!config.API_KEYS_ENABLED ? 'selected' : ''}>禁用</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>API密钥（逗号分隔）</label>
                    <textarea name="api_secret_keys" rows="3" placeholder="key1,key2,key3">${config.API_SECRET_KEYS.join(',')}</textarea>
                    <small>多个密钥用逗号分隔，启用验证后必须提供其中一个密钥才能访问</small>
                </div>
            </div>
            
            <div class="card">
                <h2>🌐 域名限制</h2>
                <div class="form-group">
                    <label>允许调用的网站（逗号分隔）</label>
                    <textarea name="allowed_referers" rows="3" placeholder="https://your-site.com,https://www.your-domain.com">${config.ALLOWED_REFERERS.join(',')}</textarea>
                    <small>留空表示不限制，设置后只有这些网站可以调用代理服务</small>
                </div>
            </div>
            
            <button type="submit" class="btn" style="padding: 15px 30px; font-size: 16px;">💾 保存安全设置</button>
        </form>
        
        <div class="card">
            <h2>📝 使用说明</h2>
            <h3>API密钥使用方式：</h3>
            <pre style="background: #f8f9fa; padding: 15px; border-radius: 8px;">
# URL参数方式
${baseUrl}/?url=图片地址&key=你的API密钥

# 请求头方式
GET ${baseUrl}/?url=图片地址
Authorization: Bearer 你的API密钥
            </pre>
            
            <h3>WordPress集成示例：</h3>
            <pre style="background: #f8f9fa; padding: 15px; border-radius: 8px;">
add_filter('the_content', function($content) {
    $proxy_url = '${baseUrl}';
    $api_key = '你的API密钥';
    
    return preg_replace_callback(
        '/(https?:\\/\\/pic\\.haokj\\.cn\\/[^"\'\\s]+)/',
        function($matches) use ($proxy_url, $api_key) {
            return $proxy_url . '/?url=' . urlencode($matches[1]) . '&key=' . $api_key;
        },
        $content
    );
});
            </pre>
        </div>
    </div>
</body>
</html>`;
}

function generateAdminAnalyticsPage(baseUrl, summary, timeRange) {
    const hourlyData = summary ? summary.hourly_breakdown : [];
    const dailyData = summary ? summary.daily_breakdown : [];
    
    return `<!DOCTYPE html>
<html>
<head>
    <title>访问统计 - 管理面板</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #f5f7fa; color: #333; }
        .sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 250px; background: white; box-shadow: 2px 0 10px rgba(0,0,0,0.1); padding: 20px; }
        .main-content { margin-left: 270px; padding: 30px; }
        .logo { color: #4a6ee0; font-size: 24px; font-weight: bold; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
        .nav-item { display: block; padding: 12px 15px; margin: 5px 0; color: #666; text-decoration: none; border-radius: 8px; }
        .nav-item:hover, .nav-item.active { background: #4a6ee0; color: white; }
        .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 5px 15px rgba(0,0,0,0.05); margin-bottom: 20px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { text-align: center; padding: 25px; border-radius: 12px; background: #f8f9fa; }
        .stat-value { font-size: 2.5em; font-weight: bold; color: #4a6ee0; }
        .btn { background: #4a6ee0; color: white; padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; margin: 5px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #f1f5f9; }
        th { background: #f8fafc; font-weight: 600; }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="logo">🛡️ 管理面板</div>
        <a href="${baseUrl}/admin" class="nav-item">📊 仪表板</a>
        <a href="${baseUrl}/admin/config" class="nav-item">⚙️ 系统配置</a>
        <a href="${baseUrl}/admin/security" class="nav-item">🔐 安全设置</a>
        <a href="${baseUrl}/admin/analytics" class="nav-item active">📈 访问统计</a>
        <a href="${baseUrl}/admin/api" class="nav-item">🔑 API管理</a>
        <div style="position: absolute; bottom: 30px; left: 20px; right: 20px;">
            <a href="${baseUrl}/admin/logout" class="btn" style="width: 100%;">🚪 退出登录</a>
        </div>
    </div>
    
    <div class="main-content">
        <h1>📈 访问统计</h1>
        
        <div style="margin-bottom: 20px;">
            <a href="${baseUrl}/admin/analytics?range=today" class="btn ${timeRange === 'today' ? 'active' : ''}">今日</a>
            <a href="${baseUrl}/admin/analytics?range=week" class="btn ${timeRange === 'week' ? 'active' : ''}">最近7天</a>
        </div>
        
        ${summary ? `
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value">${summary.total_requests.toLocaleString()}</div>
                <div>总请求数</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${summary.total_bandwidth_mb} MB</div>
                <div>总流量</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${summary.cache_hit_rate}%</div>
                <div>缓存命中率</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${summary.avg_request_size} B</div>
                <div>平均请求大小</div>
            </div>
        </div>
        
        <div class="card">
            <h2>📅 ${timeRange === 'today' ? '今日' : '最近7天'}请求分布</h2>
            <table>
                <thead>
                    <tr>
                        <th>${timeRange === 'today' ? '时间' : '日期'}</th>
                        <th>请求数</th>
                        <th>估计流量</th>
                    </tr>
                </thead>
                <tbody>
                    ${(timeRange === 'today' ? hourlyData : dailyData).map(item => `
                        <tr>
                            <td>${timeRange === 'today' ? item.hour + ':00' : item.date}</td>
                            <td>${item.count.toLocaleString()}</td>
                            <td>${(item.count * summary.avg_request_size / 1024 / 1024).toFixed(2)} MB</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        ` : `
        <div class="card">
            <p>暂无统计数据，请确保统计功能已启用。</p>
        </div>
        `}
    </div>
</body>
</html>`;
}

function generateAdminApiPage(baseUrl, config) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>API管理 - 管理面板</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #f5f7fa; color: #333; }
        .sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 250px; background: white; box-shadow: 2px 0 10px rgba(0,0,0,0.1); padding: 20px; }
        .main-content { margin-left: 270px; padding: 30px; }
        .logo { color: #4a6ee0; font-size: 24px; font-weight: bold; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
        .nav-item { display: block; padding: 12px 15px; margin: 5px 0; color: #666; text-decoration: none; border-radius: 8px; }
        .nav-item:hover, .nav-item.active { background: #4a6ee0; color: white; }
        .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 5px 15px rgba(0,0,0,0.05); margin-bottom: 20px; }
        .btn { background: #4a6ee0; color: white; padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; margin: 5px; }
        .api-key { background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 10px 0; font-family: monospace; word-break: break-all; }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="logo">🛡️ 管理面板</div>
        <a href="${baseUrl}/admin" class="nav-item">📊 仪表板</a>
        <a href="${baseUrl}/admin/config" class="nav-item">⚙️ 系统配置</a>
        <a href="${baseUrl}/admin/security" class="nav-item">🔐 安全设置</a>
        <a href="${baseUrl}/admin/analytics" class="nav-item">📈 访问统计</a>
        <a href="${baseUrl}/admin/api" class="nav-item active">🔑 API管理</a>
        <div style="position: absolute; bottom: 30px; left: 20px; right: 20px;">
            <a href="${baseUrl}/admin/logout" class="btn" style="width: 100%;">🚪 退出登录</a>
        </div>
    </div>
    
    <div class="main-content">
        <h1>🔑 API管理</h1>
        
        <div class="card">
            <h2>🔐 当前API密钥</h2>
            ${config.API_KEYS_ENABLED && config.API_SECRET_KEYS.length > 0 ? `
                ${config.API_SECRET_KEYS.map(key => `
                    <div class="api-key">${key}</div>
                `).join('')}
            ` : `
                <p>暂无API密钥，请先在安全设置中启用并添加密钥。</p>
            `}
            
            <form action="${baseUrl}/admin/api?action=generate_key" method="post" style="margin-top: 20px;">
                <button type="submit" class="btn">🆕 生成新API密钥</button>
            </form>
        </div>
        
        <div class="card">
            <h2>📚 API文档</h2>
            <h3>基础API端点：</h3>
            <ul>
                <li><strong>GET /health</strong> - 健康检查</li>
                <li><strong>GET /config</strong> - 查看配置</li>
                <li><strong>GET /stats</strong> - 统计面板</li>
                <li><strong>GET /api/analytics/summary</strong> - 统计摘要（需要管理令牌）</li>
            </ul>
            
            <h3>图片代理API：</h3>
            <pre style="background: #f8f9fa; padding: 15px; border-radius: 8px;">
# 基础使用
GET ${baseUrl}/?url=图片地址

# 带API密钥
GET ${baseUrl}/?url=图片地址&key=API密钥

# 请求头方式
GET ${baseUrl}/?url=图片地址
Authorization: Bearer API密钥
            </pre>
        </div>
    </div>
</body>
</html>`;
}

function generateStatsPage(baseUrl) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>统计面板 - 图片代理服务</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }
        .container { max-width: 1000px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #4a6ee0, #6b46c1); color: white; padding: 40px; border-radius: 15px; margin-bottom: 30px; }
        .controls { background: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        input, button { padding: 10px 15px; margin: 5px; border: 1px solid #ddd; border-radius: 8px; }
        button { background: #4a6ee0; color: white; border: none; cursor: pointer; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 20px 0; }
        .stat { background: white; padding: 25px; border-radius: 10px; text-align: center; box-shadow: 0 5px 15px rgba(0,0,0,0.05); }
        .stat-value { font-size: 2.5em; font-weight: bold; color: #4a6ee0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 统计面板</h1>
            <p>图片代理服务的访问统计和性能数据</p>
        </div>
        
        <div class="controls">
            <input type="password" id="token" placeholder="输入管理令牌" style="width: 300px;">
            <button onclick="loadStats('today')">今日统计</button>
            <button onclick="loadStats('week')">最近7天</button>
            <button onclick="loadRealtime()">实时数据</button>
        </div>
        
        <div id="statsContainer">
            <div class="stat">
                <p>请输入管理令牌加载统计</p>
                <p style="color: #666; font-size: 14px;">管理令牌需要在管理面板中设置</p>
            </div>
        </div>
    </div>
    
    <script>
        async function loadStats(range) {
            const token = document.getElementById('token').value;
            if (!token) {
                alert('请输入管理令牌');
                return;
            }
            
            const response = await fetch('${baseUrl}/api/analytics/summary?range=' + range, {
                headers: { 'X-Admin-Token': token }
            });
            
            const data = await response.json();
            displayStats(data.data);
        }
        
        function displayStats(stats) {
            const container = document.getElementById('statsContainer');
            if (!stats) {
                container.innerHTML = '<div class="stat"><p>暂无统计数据</p></div>';
                return;
            }
            
            container.innerHTML = \`
                <div class="stats-grid">
                    <div class="stat">
                        <div class="stat-value">\${stats.total_requests.toLocaleString()}</div>
                        <div>总请求数</div>
                    </div>
                    <div class="stat">
                        <div class="stat-value">\${stats.total_bandwidth_mb} MB</div>
                        <div>总流量</div>
                    </div>
                    <div class="stat">
                        <div class="stat-value">\${stats.cache_hit_rate}%</div>
                        <div>缓存命中率</div>
                    </div>
                </div>
            \`;
        }
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
        event.respondWith(new Response('服务器内部错误', { status: 500 }));
    }
});

addEventListener('scheduled', event => {
    event.waitUntil(handleScheduledEvent(event));
});

async function handleScheduledEvent(event) {
    console.log('定时任务执行:', event.cron);
}