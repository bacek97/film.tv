import { config } from '../config.js';
import { i18n } from './i18n.js';

async function fetchTMDB(endpoint, params = {}) {
    const key = config.getTMDBKey();
    const url = new URL(`${config.tmdbBaseUrl}${endpoint}`);
    
    // Add language parameter based on current i18n setting
    params.language = i18n.getLang() === 'ru' ? 'ru-RU' : 'en-US';
    
    // Check if it's a bearer token or a query param key
    const isBearer = key.length > 50; 
    
    const options = {
        method: 'GET',
        headers: {
            accept: 'application/json',
        }
    };

    if (isBearer) {
        options.headers.Authorization = `Bearer ${key}`;
    } else {
        url.searchParams.append('api_key', key);
    }

    Object.keys(params).forEach(p => url.searchParams.append(p, params[p]));

    try {
        const response = await fetch(url.toString(), options);
        if (response.status === 401 || response.status === 403) {
            const newKey = prompt('TMDB API Key is invalid or expired. Please enter a new key:');
            if (newKey) {
                config.setTMDBKey(newKey);
                return fetchTMDB(endpoint, params); // Retry
            }
        }
        if (!response.ok) throw new Error(`TMDB error: ${response.status}`);
        return await response.json();
    } catch (err) {
        console.error('TMDB Fetch Error:', err);
        throw err;
    }
}

export const tmdbService = {
    getGenres: (type = 'movie') => fetchTMDB(`/genre/${type}/list`),
    getTrending: (type = 'movie') => fetchTMDB(`/trending/${type}/week`),
    getPopular: (type = 'movie') => fetchTMDB(`/${type}/popular`),
    search: (type, query) => fetchTMDB(`/search/${type}`, { query }),
    searchPerson: (query) => fetchTMDB('/search/person', { query }),
    searchKeyword: (query) => fetchTMDB('/search/keyword', { query }),
    getDetails: (type, id) => fetchTMDB(`/${type}/${id}`, { append_to_response: 'credits,videos' }),
    discover: (type, params) => fetchTMDB(`/discover/${type}`, params)
};
