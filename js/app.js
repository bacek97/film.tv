import { h, render } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import htm from 'htm';
import { tmdbService } from './services/tmdb.js';
import { p2pService } from './services/p2p.js';
import { i18n } from './services/i18n.js';
import { config } from './config.js';

const html = htm.bind(h);

const safeBtoa = (str) => btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode('0x' + p1)));

const getHashParams = () => {
    const hash = window.location.hash.slice(1);
    if (!hash) return { path: null, id: null };
    const parts = hash.split('/');
    const path = parts[0];
    const id = parts.slice(1).join('/'); // Support URLs with slashes as IDs
    return { path, id };
};

// ----- Room Session Helpers -----
const ROOMS_KEY = 'joined_rooms';

const getJoinedRooms = () => {
    try { return JSON.parse(localStorage.getItem(ROOMS_KEY) || '[]'); }
    catch { return []; }
};

const saveJoinedRooms = (rooms) =>
    localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));

const addJoinedRoom = (id, name) => {
    const rooms = getJoinedRooms();
    if (!rooms.find(r => r.id === id)) {
        saveJoinedRooms([...rooms, { id, name }]);
    }
};

const removeJoinedRoom = (id) =>
    saveJoinedRooms(getJoinedRooms().filter(r => r.id !== id));

// ----- RoomList Component -----
function RoomList({ onEnter }) {
    const [rooms, setRooms] = useState(getJoinedRooms());
    const [roomNames, setRoomNames] = useState({});

    useEffect(() => {
        // Fetch live room names from Gun
        rooms.forEach(r => {
            p2pService.getRoom(r.id, (data) => {
                if (data && data.name) {
                    setRoomNames(prev => ({ ...prev, [r.id]: data.name }));
                }
            });
        });
    }, []);

    const createRoom = () => {
        const id = Math.random().toString(36).substring(2, 9);
        const name = prompt(i18n.t('room_name'), 'My Movie Room');
        if (!name) return;
        p2pService.createRoom(id, name);
        addJoinedRoom(id, name);
        setRooms(getJoinedRooms());
        onEnter(id);
    };

    const leaveRoom = (id, e) => {
        e.stopPropagation();
        if (!confirm('Leave this room?')) return;
        // Clear user node from Gun
        const storageKey = `room_user_${id}`;
        const userId = localStorage.getItem(storageKey);
        if (userId) {
            gun_leave_user(id, userId);
            localStorage.removeItem(storageKey);
        }
        removeJoinedRoom(id);
        setRooms(getJoinedRooms());
    };

    return html`
        <div style="max-width:600px; margin:0 auto; padding:2rem 0;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2rem;">
                <h2 style="margin:0;">${i18n.t('rooms')}</h2>
                <button onClick=${createRoom} class="glass" style="padding:10px 24px; border-radius:30px; color:white; cursor:pointer; font-weight:600;">
                    + ${i18n.t('create_room')}
                </button>
            </div>
            ${rooms.length === 0 ? html`
                <div class="glass" style="padding:3rem; text-align:center; opacity:0.5; border-radius:16px;">
                    ${i18n.t('no_rooms')}
                </div>
            ` : rooms.map(r => html`
                <div onClick=${() => onEnter(r.id)} class="glass" style="padding:1.2rem 1.5rem; border-radius:14px; cursor:pointer; margin-bottom:1rem; display:flex; justify-content:space-between; align-items:center; transition:background 0.2s;"
                    onMouseEnter=${e => e.currentTarget.style.background='rgba(255,255,255,0.08)'}
                    onMouseLeave=${e => e.currentTarget.style.background=''}>
                    <div>
                        <div style="font-weight:700; font-size:1.05rem;">${roomNames[r.id] || r.name}</div>
                        <div style="font-size:0.75rem; opacity:0.45; margin-top:2px; font-family:monospace;">${r.id}</div>
                        <a href=${location.origin + location.pathname + '#room/' + r.id} onClick=${e => e.stopPropagation()}
                           style="font-size:0.72rem; color:var(--accent-color); opacity:0.8; text-decoration:none;">
                            ${location.origin + location.pathname}#room/${r.id}
                        </a>
                    </div>
                    <div style="display:flex; gap:8px; align-items:center;">
                        <button onClick=${(e) => leaveRoom(r.id, e)} style="background:none; border:1px solid #555; color:#aaa; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:0.8rem; transition:all 0.2s;"
                            onMouseEnter=${e => { e.currentTarget.style.borderColor='var(--accent-color)'; e.currentTarget.style.color='var(--accent-color)'; }}
                            onMouseLeave=${e => { e.currentTarget.style.borderColor='#555'; e.currentTarget.style.color='#aaa'; }}>
                            ${i18n.t('leave_room')}
                        </button>
                        <div style="background:var(--accent-color); color:white; padding:6px 18px; border-radius:8px; font-weight:600; font-size:0.85rem;">
                            ${i18n.t('join_room')} →
                        </div>
                    </div>
                </div>
            `)}
        </div>
    `;
}

// Leaves user from a Gun room node (best-effort)
function gun_leave_user(roomId, userId) {
    // Import is at module scope – p2pService has Gun access
    try { p2pService.removeUserById && p2pService.removeUserById(roomId, userId); }
    catch(e) {}
}

function App() {
    // Initial state from Hash

    const initial = getHashParams();
    const initialMode = initial.path && ['movie', 'tv', 'music', 'room'].includes(initial.path) ? initial.path : 'movie';
    // Pre-populate selectedItem from the URL so there's no null flash on mount
    const initialItem = (initial.path === 'room' && initial.id) ? { id: initial.id, type: 'room' } : null;

    const [mode, setMode] = useState(initialMode);
    const [searchQuery, setSearchQuery] = useState('');
    const [results, setResults] = useState([]);
    const [selectedItem, setSelectedItem] = useState(initialItem);
    const [loading, setLoading] = useState(false);

    // ... filters state ...
    const [showFilters, setShowFilters] = useState(false);
    const [genres, setGenres] = useState([]);
    const [withGenres, setWithGenres] = useState([]);
    const [withoutGenres, setWithoutGenres] = useState([]);
    const [sortBy, setSortBy] = useState('popularity.desc');
    const [minRating, setMinRating] = useState(0);
    const [maxRating, setMaxRating] = useState(10);
    const [minVotes, setMinVotes] = useState(0);
    const [year, setYear] = useState('');
    const [dateGte, setDateGte] = useState('');
    const [dateLte, setDateLte] = useState('');
    const [minRuntime, setMinRuntime] = useState(0);
    const [maxRuntime, setMaxRuntime] = useState(400);
    const [lang, setLang] = useState('');
    const [includeAdult, setIncludeAdult] = useState(false);
    const [withCast, setWithCast] = useState([]);
    const [withCrew, setWithCrew] = useState([]);
    const [withKeywords, setWithKeywords] = useState([]);

    // Sync state with Hash on load and change
    useEffect(() => {
        const handleHash = async () => {
            const { path, id } = getHashParams();
            if (path && ['movie', 'tv', 'music', 'room'].includes(path)) {
                setMode(path);
                if (id) {
                    if (path === 'room') {
                        setSelectedItem({ id, type: 'room' });
                        setLoading(false);
                        return;
                    }
                    setLoading(true);
                    try {
                        if (path === 'music') {
                            // 1. Try direct ID lookup
                            let entry = await p2pService.getMusicEntry(id);
                            if (entry) {
                                setSelectedItem(entry);
                                setLoading(false);
                            } else {
                                // 2. Try to find by streamLink if ID is a URL
                                let found = false;
                                const unsubscribe = p2pService.subscribeMusicIndex((data, key) => {
                                    if (!found && data && (data.streamLink === id || key === id)) {
                                        found = true;
                                        setSelectedItem({ ...data, id: key });
                                        setLoading(false);
                                        if (unsubscribe && typeof unsubscribe === 'function') unsubscribe();
                                    }
                                });
                                setTimeout(() => { 
                                    if (!found) {
                                        setSelectedItem({ id, title: 'Loading...', artist: '' });
                                        setLoading(false);
                                    }
                                }, 3000);
                            }
                        } else {
                            const details = await tmdbService.getDetails(path, id);
                            setSelectedItem(details);
                            setLoading(false);
                        }
                    } catch (e) { 
                        console.error(e);
                        setLoading(false);
                    }
                } else {
                    setSelectedItem(null);
                }
            }
        };

        window.addEventListener('hashchange', handleHash);
        handleHash(); // Initial check
        return () => window.removeEventListener('hashchange', handleHash);
    }, []);

    // Clear results and selection when switching modes (but not if it's the same mode or room)
    useEffect(() => {
        setResults([]);
        // We only clear selectedItem if the mode really changed AND it's not a room
        // Actually, it's better to just not clear it here and let handleHash handle it
    }, [mode]);

    // Update Hash when mode or selection changes
    // IMPORTANT: never overwrite hash if we already have a valid hash in the URL
    // and we're just in the process of rehydrating state from it.
    useEffect(() => {
        const currentHash = window.location.hash.slice(1);
        
        // For rooms: if selectedItem is set, always write room/id
        if (selectedItem && selectedItem.type === 'room') {
            const desired = `room/${selectedItem.id}`;
            if (currentHash !== desired) window.location.hash = desired;
            // Also register in local history
            p2pService.getRoom(selectedItem.id, (data) => {
                if (data && data.name) {
                    addJoinedRoom(selectedItem.id, data.name);
                }
            });
            return;
        }

        // No selected item: hash = mode only
        if (!selectedItem) {
            if (currentHash !== mode) window.location.hash = mode;
            return;
        }

        let idPart = selectedItem.streamLink || selectedItem.id || safeBtoa(selectedItem.title).replace(/[+/=]/g, '');
        const newHash = `${mode}/${idPart}`;
        if (currentHash !== newHash) {
            window.location.hash = newHash;
        }
    }, [mode, selectedItem]);

    // Fetch genres when mode changes (skip for room and music — they have no TMDB genres)
    useEffect(() => {
        if (mode !== 'music' && mode !== 'room') {
            tmdbService.getGenres(mode).then(data => setGenres(data.genres || []));
        }
    }, [mode]);

    // Debounced filter application
    useEffect(() => {
        if (mode === 'music' || selectedItem) return;

        const timer = setTimeout(() => {
            applyFilters();
        }, 500); // Wait 500ms after last change

        return () => clearTimeout(timer);
    }, [mode, selectedItem, searchQuery, withGenres, withoutGenres, sortBy, minRating, maxRating, minVotes, year, dateGte, dateLte, minRuntime, maxRuntime, lang, includeAdult, withCast, withCrew, withKeywords]);

    // Music subscription
    useEffect(() => {
        if (mode !== 'music') return;
        setResults([]);
        setLoading(true);
        console.log('[P2P] Subscribing to music index...');

        const unsubscribe = p2pService.subscribeMusicIndex((data, id) => {
            if (data) {
                console.log('[P2P] Received music track:', data.title);
                setResults(prev => {
                    if (prev.some(p => p.id === id)) return prev;
                    return [...prev, { ...data, id }].sort((a, b) => b.timestamp - a.timestamp);
                });
                setLoading(false);
            }
        });

        // Timeout to stop loading spinner even if no tracks found
        const timer = setTimeout(() => setLoading(false), 3000);

        return () => {
            console.log('[P2P] Unsubscribing from music');
            if (unsubscribe && typeof unsubscribe === 'function') unsubscribe();
            clearTimeout(timer);
        };
    }, [mode]);

    // Local filtering for music
    const filteredResults = useMemo(() => {
        if (mode !== 'music') return results;
        if (!searchQuery) return results;
        const q = searchQuery.toLowerCase();
        return results.filter(item =>
            (item.title && item.title.toLowerCase().includes(q)) ||
            (item.artist && item.artist.toLowerCase().includes(q))
        );
    }, [results, searchQuery, mode]);

    const createRoom = () => {
        const id = Math.random().toString(36).substring(2, 9);
        const name = prompt(i18n.t('room_name'), 'My Movie Room');
        if (name) {
            p2pService.createRoom(id, name);
            window.location.hash = `room/${id}`;
        }
    };

    const applyFilters = async () => {
        setLoading(true);
        try {
            const params = {
                sort_by: sortBy,
                'vote_average.gte': minRating,
                'vote_average.lte': maxRating,
                'vote_count.gte': minVotes,
                'with_runtime.gte': minRuntime,
                'with_runtime.lte': maxRuntime,
                with_genres: withGenres.join(','),
                without_genres: withoutGenres.join(','),
                include_adult: includeAdult,
                with_original_language: lang,
                with_cast: withCast.map(c => c.id).join(','),
                with_crew: withCrew.map(c => c.id).join(','),
                with_keywords: withKeywords.map(k => k.id).join(','),
            };
            if (year) {
                if (mode === 'movie') params.primary_release_year = year;
                else params.first_air_date_year = year;
            }
            if (dateGte) params[mode === 'movie' ? 'release_date.gte' : 'first_air_date.gte'] = dateGte;
            if (dateLte) params[mode === 'movie' ? 'release_date.lte' : 'first_air_date.lte'] = dateLte;

            const data = await tmdbService.discover(mode, params);
            setResults(data.results);
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    };

    const handleSearch = async (e) => {
        const query = e.target.value;
        setSearchQuery(query);
        if (query.length > 2) {
            setLoading(true);
            try {
                if (mode !== 'music') {
                    const data = await tmdbService.search(mode, query);
                    setResults(data.results);
                }
            } catch (e) { console.error(e); }
            finally { setLoading(false); }
        } else if (!query) {
            applyFilters();
        }
    };

    const selectItem = async (item) => {
        setLoading(true);
        try {
            if (mode !== 'music') {
                const details = await tmdbService.getDetails(mode, item.id);
                setSelectedItem(details);
            } else {
                window.lastSelectedMusic = item;
                setSelectedItem(item);
            }
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    };

    return html`
        <div class="app-wrapper">
            <header class="glass">
                <a href="#" class="logo" onClick=${(e) => { e.preventDefault(); setSelectedItem(null); setSearchQuery(''); window.location.hash = 'movie'; }}>FILM.TV</a>
                <nav>
                    <a href="#movie" class="nav-link ${mode === 'movie' ? 'active' : ''}" onClick=${() => { setMode('movie'); setSelectedItem(null); }}>${i18n.t('movies')}</a>
                    <a href="#tv" class="nav-link ${mode === 'tv' ? 'active' : ''}" onClick=${() => { setMode('tv'); setSelectedItem(null); }}>${i18n.t('tv')}</a>
                    <a href="#music" class="nav-link ${mode === 'music' ? 'active' : ''}" onClick=${() => { setMode('music'); setSelectedItem(null); }}>${i18n.t('music')}</a>
                    <a href="#room" class="nav-link ${mode === 'room' ? 'active' : ''}" onClick=${() => { setMode('room'); setSelectedItem(null); }}>${i18n.t('rooms')}</a>
                </nav>
                <div class="lang-switch">
                    <span onClick=${() => i18n.setLang('ru')} style="cursor:pointer; opacity:${i18n.getLang() === 'ru' ? 1 : 0.5}">RU</span>
                    <span onClick=${() => i18n.setLang('en')} style="cursor:pointer; margin-left:10px; opacity:${i18n.getLang() === 'en' ? 1 : 0.5}">EN</span>
                </div>
            </header>

            <main>
                ${mode === 'room' && !selectedItem ? html`<${RoomList} onEnter=${(id) => { window.location.hash = 'room/' + id; }} />` : ''}

                ${selectedItem && selectedItem.type === 'room' ? html`<${Room} roomId=${selectedItem.id} />` : 
                  selectedItem ? html`<${Details} item=${selectedItem} mode=${mode} onBack=${() => setSelectedItem(null)} />` : html`
                    <div class="search-container">
                        <div style="display:flex; gap:1rem;">
                            <input type="text" class="search-input" placeholder="${i18n.t('search')}" value=${searchQuery} onInput=${handleSearch} />
                            ${mode !== 'music' && html`<button onClick=${() => setShowFilters(!showFilters)} class="glass" style="border-radius:30px; padding:0 20px; color:white; cursor:pointer;">${showFilters ? '✕' : i18n.t('filters')}</button>`}
                        </div>
                    </div>
                    
                    ${showFilters && mode !== 'music' && html`
                        <${FiltersPanel} 
                            genres=${genres} 
                            withGenres=${withGenres} setWithGenres=${setWithGenres}
                            withoutGenres=${withoutGenres} setWithoutGenres=${setWithoutGenres}
                            sortBy=${sortBy} setSortBy=${setSortBy}
                            minRating=${minRating} setMinRating=${setMinRating}
                            maxRating=${maxRating} setMaxRating=${setMaxRating}
                            minVotes=${minVotes} setMinVotes=${setMinVotes}
                            year=${year} setYear=${setYear}
                            dateGte=${dateGte} setDateGte=${setDateGte}
                            dateLte=${dateLte} setDateLte=${setDateLte}
                            minRuntime=${minRuntime} setMinRuntime=${setMinRuntime}
                            maxRuntime=${maxRuntime} setMaxRuntime=${setMaxRuntime}
                            lang=${lang} setLang=${setLang}
                            includeAdult=${includeAdult} setIncludeAdult=${setIncludeAdult}
                            withCast=${withCast} setWithCast=${setWithCast}
                            withCrew=${withCrew} setWithCrew=${setWithCrew}
                            withKeywords=${withKeywords} setWithKeywords=${setWithKeywords}
                        />
                    `}

                <div style="position:relative; min-height:400px;">
                    ${loading && html`
                        <div style="position:absolute; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.3); z-index:10; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(2px); border-radius:12px;">
                            <div class="loading"></div>
                        </div>
                    `}
                    <div class="results" style="opacity:${loading ? 0.4 : 1}; transition:opacity 0.3s;">
                        ${mode === 'music' && html`<${AddMusicForm} />`}
                        
                        <div class="grid">
                            ${filteredResults.map(item => html`
                                <div class="card" onClick=${() => selectItem(item)}>
                                    <div style="aspect-ratio: 2/3; background:#222; overflow:hidden; display:flex; align-items:center; justify-content:center;">
                                        ${mode === 'music' ? html`
                                            <${DynamicCover} item=${item} />
                                        ` : (item.poster_path || item.cover) ? html`
                                            <img src="${item.poster_path ? config.tmdbImageBase + item.poster_path : item.cover}" style="width:100%; height:100%; object-fit:cover;" />
                                        ` : html`
                                            <svg viewBox="0 0 24 24" fill="#444" style="width:50px; height:50px;">
                                                <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
                                            </svg>
                                        `}
                                    </div>
                                    <div class="card-info">
                                        <div class="card-title">${item.title || item.name}</div>
                                        <div class="card-meta">${mode === 'music' ? item.artist : (item.release_date || item.first_air_date || '').split('-')[0]}</div>
                                    </div>
                                </div>
                            `)}
                        </div>
                    </div>
                </div>
                `}
            </main>
        </div>
    `;
}

function FiltersPanel(props) {
    const { genres, withGenres, setWithGenres, withoutGenres, setWithoutGenres, sortBy, setSortBy, minRating, setMinRating, maxRating, setMaxRating, minVotes, setMinVotes, year, setYear, dateGte, setDateGte, dateLte, setDateLte, minRuntime, setMinRuntime, maxRuntime, setMaxRuntime, lang, setLang, includeAdult, setIncludeAdult, withCast, setWithCast, withCrew, setWithCrew, withKeywords, setWithKeywords } = props;

    const toggleGenre = (id, list, setList) => {
        if (list.includes(id)) setList(list.filter(g => g !== id));
        else setList([...list, id]);
    };

    return html`
        <div class="glass" style="padding:1.5rem; margin-bottom:2rem; font-size:0.85rem; max-height:70vh; overflow-y:auto;">
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap:2rem;">
                
                <!-- Genres Section -->
                <div>
                    <h4 style="margin-top:0">${i18n.t('genres')} (${i18n.t('include')})</h4>
                    <div style="display:flex; flex-wrap:wrap; gap:5px; margin-bottom:10px;">
                        ${genres.map(g => html`
                            <span onClick=${() => toggleGenre(g.id, withGenres, setWithGenres)} 
                                  style="padding:3px 8px; border-radius:12px; cursor:pointer; background:${withGenres.includes(g.id) ? 'var(--accent-color)' : '#222'}; border:1px solid #444; font-size:0.75rem;">
                                ${g.name}
                            </span>
                        `)}
                    </div>
                    <h4 style="margin-top:10px">${i18n.t('genres')} (${i18n.t('exclude')})</h4>
                    <div style="display:flex; flex-wrap:wrap; gap:5px;">
                        ${genres.map(g => html`
                            <span onClick=${() => toggleGenre(g.id, withoutGenres, setWithoutGenres)} 
                                  style="padding:3px 8px; border-radius:12px; cursor:pointer; background:${withoutGenres.includes(g.id) ? '#800' : '#222'}; border:1px solid #444; font-size:0.75rem;">
                                ${g.name}
                            </span>
                        `)}
                    </div>
                </div>

                <!-- Sort & Basics -->
                <div style="display:grid; gap:1rem;">
                    <div>
                        <label>${i18n.t('sort_by')}</label>
                        <select value=${sortBy} onChange=${e => setSortBy(e.target.value)} style="width:100%; background:#222; color:white; border:1px solid #444; padding:6px; border-radius:4px;">
                            <option value="popularity.desc">${i18n.t('sort_pop_desc')}</option>
                            <option value="popularity.asc">${i18n.t('sort_pop_asc')}</option>
                            <option value="vote_average.desc">${i18n.t('sort_rate_desc')}</option>
                            <option value="vote_average.asc">${i18n.t('sort_rate_asc')}</option>
                            <option value="vote_count.desc">${i18n.t('sort_count_desc')}</option>
                            <option value="vote_count.asc">${i18n.t('sort_count_asc')}</option>
                            <option value="release_date.desc">${i18n.t('sort_date_desc')}</option>
                            <option value="release_date.asc">${i18n.t('sort_date_asc')}</option>
                            <option value="primary_release_date.desc">${i18n.t('sort_pdate_desc')}</option>
                            <option value="primary_release_date.asc">${i18n.t('sort_pdate_asc')}</option>
                        </select>
                    </div>
                    <div style="display:flex; gap:1rem; align-items:center;">
                        <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
                            <input type="checkbox" checked=${includeAdult} onChange=${e => setIncludeAdult(e.target.checked)} /> ${i18n.t('adult_content')}
                        </label>
                        <div>
                            <label>${i18n.t('lang_label')}</label>
                            <input type="text" placeholder="en" value=${lang} onInput=${e => setLang(e.target.value)} style="width:40px; background:#222; border:1px solid #444; color:white; padding:4px; margin-left:5px;" />
                        </div>
                    </div>
                </div>

                <!-- Ranges -->
                <div style="display:grid; gap:0.5rem;">
                    <label>${i18n.t('rating')}: ${minRating} - ${maxRating}</label>
                    <${MultiRangeSlider} min="0" max="10" step="0.5" minValue=${minRating} maxValue=${maxRating} onInput=${(min, max) => { setMinRating(min); setMaxRating(max); }} />

                    <label>${i18n.t('runtime')}: ${minRuntime} - ${maxRuntime} мин</label>
                    <${MultiRangeSlider} min="0" max="400" step="1" minValue=${minRuntime} maxValue=${maxRuntime} onInput=${(min, max) => { setMinRuntime(min); setMaxRuntime(max); }} />

                    <label>${i18n.t('min_votes')}: ${minVotes}</label>
                    <input type="range" class="single-range" min="0" max="10000" step="50" value=${minVotes} onInput=${e => setMinVotes(Number(e.target.value))} />
                </div>

                <!-- Live Searches & Dates -->
                <div style="display:grid; gap:0.5rem;">
                    <label>${i18n.t('release_date')}</label>
                    <div style="display:flex; gap:5px; margin-bottom:10px;">
                        <input type="date" value=${dateGte} onChange=${e => setDateGte(e.target.value)} style="flex:1; background:#222; border:1px solid #444; color:white; padding:4px;" />
                        <input type="date" value=${dateLte} onChange=${e => setDateLte(e.target.value)} style="flex:1; background:#222; border:1px solid #444; color:white; padding:4px;" />
                    </div>
                    
                    <${EntitySearch} label=${i18n.t('cast')} type="person" selected=${withCast} onSelect=${(item) => setWithCast([...withCast, item])} onRemove=${(id) => setWithCast(withCast.filter(c => c.id !== id))} />
                    <${EntitySearch} label=${i18n.t('crew')} type="person" selected=${withCrew} onSelect=${(item) => setWithCrew([...withCrew, item])} onRemove=${(id) => setWithCrew(withCrew.filter(c => c.id !== id))} />
                    <${EntitySearch} label=${i18n.t('keywords')} type="keyword" selected=${withKeywords} onSelect=${(item) => setWithKeywords([...withKeywords, item])} onRemove=${(id) => setWithKeywords(withKeywords.filter(k => k.id !== id))} />
                </div>

            </div>
        </div>
    `;
}

function MultiRangeSlider({ min, max, step, minValue, maxValue, onInput }) {
    const minVal = Number(minValue);
    const maxVal = Number(maxValue);
    const rangeMin = Number(min);
    const rangeMax = Number(max);

    const minPercent = Math.max(0, Math.min(100, ((minVal - rangeMin) / (rangeMax - rangeMin)) * 100));
    const maxPercent = Math.max(0, Math.min(100, ((maxVal - rangeMin) / (rangeMax - rangeMin)) * 100));

    return html`
        <div class="range-slider">
            <div class="range-track" style="left: ${minPercent}%; right: ${100 - maxPercent}%;"></div>
            <input type="range" min=${rangeMin} max=${rangeMax} step=${step} value=${minVal} 
                   onInput=${e => {
            const val = Math.min(Number(e.target.value), maxVal - Number(step));
            onInput(val, maxVal);
        }} />
            <input type="range" min=${rangeMin} max=${rangeMax} step=${step} value=${maxVal} 
                   onInput=${e => {
            const val = Math.max(Number(e.target.value), minVal + Number(step));
            onInput(minVal, val);
        }} />
        </div>
    `;
}

function EntitySearch({ label, type, selected, onSelect, onRemove }) {
    const [query, setQuery] = useState('');
    const [suggestions, setSuggestions] = useState([]);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (!e.target.closest('.entity-search-container')) {
                setSuggestions([]);
            }
        };
        window.addEventListener('click', handleClickOutside);
        return () => window.removeEventListener('click', handleClickOutside);
    }, []);

    useEffect(() => {
        const timer = setTimeout(async () => {
            if (query.length > 0) {
                const data = type === 'person' ? await tmdbService.searchPerson(query) : await tmdbService.searchKeyword(query);
                setSuggestions(data.results.slice(0, 5));
            } else {
                setSuggestions([]);
            }
        }, 300);
        return () => clearTimeout(timer);
    }, [query, type]);

    return html`
        <div class="entity-search-container" style="margin-bottom:10px;">
            <label style="font-size:0.75rem; color:var(--text-secondary)">${label}</label>
            <div style="display:flex; flex-wrap:wrap; gap:5px; margin-bottom:5px;">
                ${selected.map(item => html`
                    <span onClick=${() => onRemove(item.id)} style="padding:2px 8px; background:var(--accent-color); border-radius:10px; font-size:0.7rem; cursor:pointer;">
                        ${item.name} ×
                    </span>
                `)}
            </div>
            <div style="position:relative;">
                <input type="text" value=${query} onInput=${e => setQuery(e.target.value)} placeholder="${i18n.t('search_for', { label })}" 
                       style="width:100%; background:#222; border:1px solid #444; color:white; padding:6px; border-radius:4px; font-size:0.8rem;" />
                ${suggestions.length > 0 && html`
                    <div style="position:absolute; top:100%; left:0; right:0; z-index:100; max-height:250px; overflow-y:auto; margin-top:5px; background:#111; border:1px solid #444; border-radius:8px; box-shadow:0 10px 30px rgba(0,0,0,0.5);">
                        ${suggestions.map(s => html`
                            <div onClick=${() => { onSelect({ id: s.id, name: s.name }); setQuery(''); setSuggestions([]); }} 
                                 style="padding:10px; cursor:pointer; border-bottom:1px solid #222; font-size:0.85rem; display:flex; align-items:center; gap:12px; transition: background 0.2s;" 
                                 onMouseEnter=${e => e.target.style.background = '#222'} 
                                 onMouseLeave=${e => e.target.style.background = 'transparent'}>
                                ${type === 'person' && html`
                                    <div style="width:35px; height:35px; border-radius:50%; overflow:hidden; background:#333; flex-shrink:0; display:flex; align-items:center; justify-content:center;">
                                        ${s.profile_path ? html`
                                            <img src="${config.tmdbImageBase + s.profile_path}" style="width:100%; height:100%; object-fit:cover;" />
                                        ` : html`
                                            <svg viewBox="0 0 24 24" fill="#666" style="width:20px; height:20px;">
                                                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                                            </svg>
                                        `}
                                    </div>
                                `}
                                <div>
                                    <div style="font-weight:600;">${s.name}</div>
                                    ${s.known_for_department ? html`<small style="opacity:0.6; font-size:0.7rem;">${i18n.t(s.known_for_department)}</small>` : ''}
                                </div>
                            </div>
                        `)}
                    </div>
                `}
            </div>
        </div>
    `;
}

function DynamicCover({ item }) {
    const [cover, setCover] = useState(item.cover || null);
    const [loading, setLoading] = useState(!item.cover);

    // We use a simple element id or reference to observe
    const id = `cover-${item.id}`;

    useEffect(() => {
        if (item.cover) return;

        console.log('[P2P] DynamicCover initialized for:', item.title, 'ID:', item.id);

        const el = document.getElementById(id);
        if (!el) {
            console.warn('[P2P] Could not find element for observer:', id);
            return;
        }

        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                console.log('[P2P] Item in view, loading cover for:', item.title);
                observer.disconnect();
                const loadCover = async () => {
                    try {
                        // 1. Try Spotify first if we have a link (SUPER FAST)
                        let slink = item.streamLink;
                        if (!slink) {
                            // Deep lookup for legacy tracks
                            slink = await p2pService.findLinkByType(item.id, 'stream');
                        }

                        if (slink) {
                            console.log('[P2P] Fast cover load from StreamLink:', slink);
                            const meta = await p2pService.fetchMetadata(slink);
                            if (meta && meta.cover) {
                                setCover(meta.cover);
                                return;
                            }
                        }

                        // 2. Fallback to P2P inspection (SLOW)
                        const magnet = await p2pService.getMagnetLinkForMusic(item.id);
                        if (magnet) {
                            console.log('[P2P] Starting inspection for dynamic cover...');
                            const info = await p2pService.inspectMagnet(magnet);
                            const extractedCover = info.audioMeta?.coverUrl || info.coverUrl;
                            if (extractedCover) {
                                console.log('[P2P] Dynamic cover extracted successfully');
                                setCover(extractedCover);
                            }
                        }
                    } catch (e) { console.warn('[P2P] Dynamic cover load failed', e); }
                    finally { setLoading(false); }
                };
                loadCover();
            }
        }, { threshold: 0.1 });

        observer.observe(el);
        return () => observer.disconnect();
    }, [item.id, item.cover]);

    if (cover) {
        return html`<img src="${cover}" style="width:100%; height:100%; object-fit:cover;" />`;
    }

    return html`
        <div id=${id} style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:#333;">
            ${loading ? html`<div class="loading" style="width:20px; height:20px; border-width:2px; border-top-color:var(--accent-color);"></div>` : html`
                <svg viewBox="0 0 24 24" fill="#666" style="width:40px; height:40px;">
                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                </svg>
            `}
        </div>
    `;
}

function AddMusicForm() {
    const [title, setTitle] = useState('');
    const [artist, setArtist] = useState('');
    const [album, setAlbum] = useState('');
    const [format, setFormat] = useState('');
    const [bitrate, setBitrate] = useState('');
    const [coverUrl, setCoverUrl] = useState('');
    const [streamLink, setStreamLink] = useState('');
    const [magnetLink, setMagnetLink] = useState('');
    const [isValidating, setIsValidating] = useState(false);
    const [validationError, setValidationError] = useState('');
    const [isOpen, setIsOpen] = useState(false);

    // Comparison states
    const [streamMeta, setStreamMeta] = useState(null);
    const [fileMeta, setFileMeta] = useState(null);

    const submit = async (e) => {
        e.preventDefault();
        if (!title || !artist || !streamLink || !magnetLink) return;

        setIsValidating(true);
        setValidationError('');

        try {
            const finalTitle = title || fileMeta?.title || streamMeta?.title;
            const finalArtist = artist || fileMeta?.artist || streamMeta?.artist;

            // No cover stored in GUN, only title, artist and links
            p2pService.addMusicEntry(finalTitle, finalArtist, { url: streamLink, type: 'stream' }, album, format, bitrate);
            p2pService.addLink('music', safeBtoa(`${finalArtist.toLowerCase()}_${finalTitle.toLowerCase()}`).replace(/[+/=]/g, ''), { url: magnetLink, type: 'magnet' });

            setTitle(''); setArtist(''); setAlbum(''); setFormat(''); setBitrate(''); setCoverUrl(''); setStreamLink(''); setMagnetLink('');
            setStreamMeta(null); setFileMeta(null);
            setIsOpen(false);
        } catch (err) {
            setValidationError(err.toString());
        } finally {
            setIsValidating(false);
        }
    };

    const handleStreamLinkInput = async (val) => {
        setStreamLink(val);
        if (val.startsWith('http')) {
            const meta = await p2pService.fetchMetadata(val);
            if (meta) {
                setStreamMeta(meta);
                if (!title) setTitle(meta.title || '');
                if (!artist) setArtist(meta.artist || '');
            }
        }
    };

    const handleMagnetInput = async (val) => {
        setMagnetLink(val);
        if (val.startsWith('magnet:')) {
            setIsValidating(true);
            try {
                const info = await p2pService.inspectMagnet(val);
                if (info.audioMeta) {
                    const extracted = {
                        title: info.audioMeta.title || '',
                        artist: info.audioMeta.artist || '',
                        album: info.audioMeta.album || '',
                        format: info.audioMeta.format || '',
                        bitrate: info.audioMeta.bitrate || '',
                        cover: info.audioMeta.coverUrl || info.coverUrl || null
                    };
                    setFileMeta(extracted);

                    // Auto-fill if empty
                    if (!title) setTitle(extracted.title);
                    if (!artist) setArtist(extracted.artist);
                    if (!album) setAlbum(extracted.album);
                    if (!format) setFormat(extracted.format);
                    if (!bitrate) setBitrate(extracted.bitrate);
                }
            } catch (e) { setValidationError(e.toString()); }
            finally { setIsValidating(false); }
        }
    };

    if (!isOpen) return html`<button onClick=${() => setIsOpen(true)} class="glass" style="width:100%; padding:1rem; color:white; margin-bottom:2rem; cursor:pointer;">+ ${i18n.t('add_link')} (Music)</button>`;

    return html`
        <form onSubmit=${submit} class="glass" style="padding:1.5rem; margin-bottom:2rem; display:grid; gap:1.5rem;">
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1.5rem;">
                <!-- Link Section -->
                <div style="display:grid; gap:0.5rem;">
                    <label style="font-size:0.8rem; opacity:0.7;">Streaming Link (Spotify/Apple) *</label>
                    <input type="url" placeholder="https://..." required value=${streamLink} onInput=${e => handleStreamLinkInput(e.target.value)} style="padding:10px; background:#222; border:1px solid #444; color:white; border-radius:8px;" />
                    
                    ${streamMeta && html`
                        <div class="glass" style="padding:10px; margin-top:10px; display:flex; gap:10px; align-items:center; background:rgba(29, 185, 84, 0.1);">
                            ${streamMeta.cover ? html`<img src=${streamMeta.cover} style="width:50px; height:50px; border-radius:4px; object-fit:cover;" />` : html`<div style="width:50px; height:50px; background:#222; display:flex; align-items:center; justify-content:center;">🎵</div>`}
                            <div style="font-size:0.8rem; overflow:hidden;">
                                <div style="font-weight:bold; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">${streamMeta.title || 'Unknown Title'}</div>
                                <div style="opacity:0.7;">${streamMeta.artist || 'Unknown Artist'}</div>
                                <div style="color:#1db954; font-size:0.7rem; margin-top:2px;">✔ Verified from Link</div>
                            </div>
                        </div>
                    `}
                </div>

                <!-- P2P Section -->
                <div style="display:grid; gap:0.5rem;">
                    <label style="font-size:0.8rem; opacity:0.7;">Magnet Link (File Scanning) *</label>
                    <input type="text" placeholder="magnet:?xt=urn:btih:..." required value=${magnetLink} onInput=${e => handleMagnetInput(e.target.value)} style="padding:10px; background:#222; border:1px solid #444; color:white; border-radius:8px;" />
                    
                    ${fileMeta && html`
                        <div class="glass" style="padding:10px; margin-top:10px; display:flex; gap:10px; align-items:center; background:rgba(255, 255, 255, 0.05);">
                            <div style="width:50px; height:50px; border-radius:4px; background:#333; display:flex; align-items:center; justify-content:center; overflow:hidden;">
                                ${fileMeta.cover ? html`<img src=${fileMeta.cover} style="width:100%; height:100%; object-fit:cover;" />` : '💿'}
                            </div>
                            <div style="font-size:0.8rem; overflow:hidden;">
                                <div style="font-weight:bold; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">${fileMeta.title}</div>
                                <div style="opacity:0.7;">${fileMeta.artist}</div>
                                <div style="opacity:0.5; font-size:0.7rem; margin-top:2px;">${fileMeta.format} | ${fileMeta.bitrate} kbps</div>
                            </div>
                        </div>
                    `}
                </div>
            </div>

            <hr style="opacity:0.1; margin:0;" />

            <!-- Final Confirmation Fields -->
            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:1rem;">
                <div style="display:grid; gap:0.3rem;">
                    <label style="font-size:0.7rem; opacity:0.5;">Final Title</label>
                    <input type="text" value=${title} onInput=${e => setTitle(e.target.value)} style="padding:8px; background:#111; border:1px solid #333; color:white; border-radius:6px;" />
                </div>
                <div style="display:grid; gap:0.3rem;">
                    <label style="font-size:0.7rem; opacity:0.5;">Final Artist</label>
                    <input type="text" value=${artist} onInput=${e => setArtist(e.target.value)} style="padding:8px; background:#111; border:1px solid #333; color:white; border-radius:6px;" />
                </div>
                <div style="display:grid; gap:0.3rem;">
                    <label style="font-size:0.7rem; opacity:0.5;">Album</label>
                    <input type="text" value=${album} onInput=${e => setAlbum(e.target.value)} style="padding:8px; background:#111; border:1px solid #333; color:white; border-radius:6px;" />
                </div>
            </div>

            ${validationError && html`<div style="color:#ff4444; font-size:0.85rem;">${validationError}</div>`}

            <div style="display:flex; gap:1rem; margin-top:0.5rem;">
                <button type="submit" disabled=${isValidating || !title} style="flex:1; background:var(--accent-color); color:white; border:none; padding:12px; border-radius:8px; cursor:pointer; font-weight:bold; opacity:${(isValidating || !title) ? 0.5 : 1}">
                    ${isValidating ? 'Verifying...' : 'Create Validated Track'}
                </button>
                <button type="button" onClick=${() => setIsOpen(false)} style="background:#444; color:white; border:none; padding:12px; border-radius:8px; cursor:pointer;">${i18n.t('cancel')}</button>
            </div>
        </form>
    `;
}

function Details({ item, mode, onBack }) {
    const [links, setLinks] = useState({});
    const [newLink, setNewLink] = useState('');
    const [linkType, setLinkType] = useState('magnet');
    const [isValidating, setIsValidating] = useState(false);
    const [validationError, setValidationError] = useState('');
    const [openRoomDrop, setOpenRoomDrop] = useState(null); // linkId that has dropdown open
    const joinedRooms = getJoinedRooms();

    const addLinkToRoom = (roomId, roomName, url, title) => {
        const type = url.startsWith('magnet:') ? 'magnet' : 'stream';
        p2pService.addToPlaylist(roomId, { url, title, type });
        setOpenRoomDrop(null);
        // Brief toast via title bar
        const orig = document.title;
        document.title = `✔ Added to ${roomName}`;
        setTimeout(() => { document.title = orig; }, 2000);
    };

    useEffect(() => {
        const id = item.id || safeBtoa(`${item.artist?.toLowerCase() || ''}_${item.title?.toLowerCase() || ''}`).replace(/[+/=]/g, '');
        const verifiedHashes = new Set();

        const unsubscribe = p2pService.subscribeLinks(mode, id, async (data, linkId) => {
            if (data) {
                if (data.type === 'magnet') {
                    // Check if already verified in this session to avoid loops/extra work
                    if (verifiedHashes.has(data.url)) return;

                    try {
                        await p2pService.inspectMagnet(data.url);
                        verifiedHashes.add(data.url);
                        setLinks(prev => ({ ...prev, [linkId]: data }));
                    } catch (e) {
                        console.warn('Filtering trash/offline magnet:', data.url, e);
                        // Optionally: setLinks(prev => ({ ...prev, [linkId]: { ...data, invalid: true } }));
                    }
                } else {
                    setLinks(prev => ({ ...prev, [linkId]: data }));
                }
            }
        });
    }, [item, mode]);

    const submitLink = async () => {
        if (!newLink) return;
        setIsValidating(true);
        setValidationError('');

        try {
            if (linkType === 'magnet') {
                await p2pService.inspectMagnet(newLink);
            }

            const id = item.id || safeBtoa(`${item.artist?.toLowerCase() || ''}_${item.title?.toLowerCase() || ''}`).replace(/[+/=]/g, '');
            p2pService.addLink(mode, id, { url: newLink, type: linkType });
            setNewLink('');
        } catch (err) {
            setValidationError(err.toString());
        } finally {
            setIsValidating(false);
        }
    };

    const allLinks = [...Object.entries(links)];
    if (item.streamLink && !allLinks.some(l => l[1].url === item.streamLink)) {
        allLinks.push(['primary', { url: item.streamLink, type: 'stream', views: 0 }]);
    }

    const sortedLinks = allLinks.sort((a, b) => (b[1].views || 0) - (a[1].views || 0));
    const streamLinks = sortedLinks.filter(l => l[1].type === 'stream');
    const magnetLinks = sortedLinks.filter(l => l[1].type === 'magnet');

    const handlePlay = (linkId, url) => {
        const id = item.id || safeBtoa(`${item.artist?.toLowerCase() || ''}_${item.title?.toLowerCase() || ''}`).replace(/[+/=]/g, '');
        p2pService.incrementView(mode, id, linkId);
        startPlayback(url);
    };

    return html`
        <div class="details-page">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:1rem;">
                <button onClick=${onBack} style="background:none; border:none; color:var(--accent-color); cursor:pointer; font-size:1rem;">← ${i18n.t('back')}</button>
            </div>
            <div style="display:flex; gap:2rem; flex-wrap:wrap;">
                <div style="width:300px; aspect-ratio: 1/1; background:#222; border-radius:12px; overflow:hidden; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                    ${mode === 'music' ? html`
                        <${DynamicCover} item=${item} />
                    ` : (item.poster_path || item.cover) ? html`
                        <img src="${item.poster_path ? config.tmdbImageBase + item.poster_path : item.cover}" style="width:100%; height:100%; object-fit:cover;" />
                    ` : html`
                        <svg viewBox="0 0 24 24" fill="#444" style="width:80px; height:80px;">
                            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                        </svg>
                    `}
                </div>
                <div style="flex:1; min-width:300px;">
                    <h1>${item.title || item.name}</h1>
                    ${item.artist && html`<h2 style="opacity:0.6">${item.artist}</h2>`}
                    ${item.album && html`<h3 style="opacity:0.4; font-size:1.1rem; margin-bottom:1rem;">${item.album}</h3>`}
                    
                    ${mode === 'music' && (item.format || item.bitrate) && html`
                        <div style="display:flex; gap:1rem; margin-bottom:1rem; font-size:0.85rem; opacity:0.6;">
                            ${item.format && html`<span>Format: <b>${item.format}</b></span>`}
                            ${item.bitrate && html`<span>Bitrate: <b>${item.bitrate} kbps</b></span>`}
                        </div>
                    `}
                    
                    <p style="color:var(--text-secondary)">${item.overview || ''}</p>
                    
                    <div class="contribution glass" style="padding:1.5rem; margin-top:2rem;">
                        <h3>${i18n.t('add_link')}</h3>
                        <div style="display:flex; gap:1rem; margin-bottom:1rem;">
                            <select value=${linkType} onChange=${e => setLinkType(e.target.value)} style="background:#222; color:white; border:1px solid #444; border-radius:4px; padding:5px;">
                                <option value="stream">Streaming Link</option>
                                <option value="magnet">Magnet</option>
                            </select>
                            <input type="text" placeholder="URL / Magnet" value=${newLink} onInput=${e => setNewLink(e.target.value)} style="flex:1; background:#222; border:1px solid #444; color:white; padding:5px; border-radius:4px;" />
                            <button onClick=${submitLink} disabled=${isValidating} style="background:var(--accent-color); color:white; border:none; padding:5px 15px; border-radius:4px; cursor:pointer; opacity:${isValidating ? 0.5 : 1}">
                                ${isValidating ? '...' : '+'}
                            </button>
                        </div>
                        ${validationError && html`<div style="color:#ff4444; font-size:0.8rem; margin-bottom:1rem;">${validationError}</div>`}
                        ${isValidating && html`<div style="color:var(--accent-color); font-size:0.8rem; margin-bottom:1rem;">Checking magnet content...</div>`}

                        ${streamLinks.length > 0 && html`
                            <div style="margin-bottom:1.5rem;">
                                <h4 style="margin-bottom:0.5rem; opacity:0.8">Streaming Platforms</h4>
                                <div style="display:flex; flex-wrap:wrap; gap:10px;">
                                    ${streamLinks.map(([linkId, link]) => html`
                                        <a href="${link.url}" target="_blank" class="glass" style="padding:8px 15px; border-radius:20px; text-decoration:none; color:white; font-size:0.85rem; border:1px solid #444;">
                                            ${new URL(link.url).hostname.replace('www.', '')} ↗
                                        </a>
                                    `)}
                                </div>
                            </div>
                        `}

                        <div class="links-list">
                            <h4 style="margin-bottom:0.5rem; opacity:0.8">P2P Sources / Magnets</h4>
                            ${magnetLinks.map(([linkId, link]) => html`
                                <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; border-bottom:1px solid #333;">
                                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; margin-right:10px;">
                                        <span style="color:var(--accent-color); font-size:0.8rem; text-transform:uppercase;">[${link.type}]</span> ${link.url}
                                    </div>
                                    <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                                        <span style="font-size:0.85rem; opacity:0.7;">${link.views || 0} 👁️</span>
                                        ${joinedRooms.length > 0 && html`
                                            <div style="position:relative;">
                                                <button onClick=${() => setOpenRoomDrop(openRoomDrop === linkId ? null : linkId)}
                                                    class="glass" style="padding:4px 10px; border-radius:6px; color:white; cursor:pointer; font-size:0.75rem; border:1px solid #555;">
                                                    + 🎥
                                                </button>
                                                ${openRoomDrop === linkId && html`
                                                    <div style="position:absolute; right:0; top:100%; margin-top:4px; background:#1a1a1a; border:1px solid #333; border-radius:8px; min-width:180px; z-index:300; box-shadow:0 8px 24px rgba(0,0,0,0.7); overflow:hidden;">
                                                        <div style="padding:8px 12px; font-size:0.72rem; opacity:0.5; border-bottom:1px solid #222;">Add to room:</div>
                                                        ${joinedRooms.map(r => html`
                                                            <div onClick=${() => addLinkToRoom(r.id, r.name, link.url, item.title || item.name)}
                                                                style="padding:10px 14px; cursor:pointer; font-size:0.82rem; transition:background 0.1s;"
                                                                onMouseEnter=${e => e.currentTarget.style.background='#2a2a2a'}
                                                                onMouseLeave=${e => e.currentTarget.style.background=''}>
                                                                <div style="font-weight:600;">${r.name}</div>
                                                                <div style="font-size:0.68rem; opacity:0.4;">${r.id}</div>
                                                            </div>
                                                        `)}
                                                    </div>
                                                `}
                                            </div>
                                        `}
                                        <button onClick=${() => handlePlay(linkId, link.url)} style="background:white; color:black; border:none; padding:5px 15px; border-radius:4px; cursor:pointer; font-weight:bold;">
                                            ${mode === 'music' ? 'Слушать' : i18n.t('play')}
                                        </button>
                                    </div>
                                </div>
                            `)}
                        </div>
                    </div>
                </div>
            </div>

            <div id="player-container" style="margin-top:2rem; display:none;">
                <video id="video-player" controls style="width:100%; max-height:80vh; background:black; border-radius:12px;"></video>
                <div id="torrent-stats" style="margin-top:10px; font-size:0.8rem; color:var(--text-secondary);"></div>
            </div>
        </div>
    `;
}

function startPlayback(magnet) {
    const container = document.getElementById('player-container');
    const player = document.getElementById('video-player');
    const stats = document.getElementById('torrent-stats');
    const { path } = getHashParams();

    if (path === 'music') {
        player.style.height = '80px';
        player.style.maxHeight = '80px';
    } else {
        player.style.height = 'auto';
        player.style.maxHeight = '80vh';
    }

    container.style.display = 'block';
    p2pService.stream(magnet, player);

    setInterval(() => {
        const data = p2pService.getTorrentStats(magnet);
        if (data) {
            stats.innerHTML = `${i18n.t('peers')}: ${data.peers} | ${i18n.t('speed')}: ${(data.downloadSpeed / 1024 / 1024).toFixed(2)} MB/s | ${(data.progress * 100).toFixed(1)}%`;
        }
    }, 2000);

    player.scrollIntoView({ behavior: 'smooth' });
}
function Room({ roomId }) {
    const [room, setRoom] = useState(null);
    // Use sessionStorage so multiple tabs on localhost act as separate users
    const storedUserId   = sessionStorage.getItem(`room_user_${roomId}`);
    const storedUserName = localStorage.getItem('userName');

    const [myUserId,  setMyUserId]  = useState(storedUserId);
    const [users,     setUsers]     = useState(() => {
        if (storedUserId && storedUserName) {
            return { [storedUserId]: { name: storedUserName, id: storedUserId, lastSeen: Date.now() } };
        }
        return {};
    });
    const [playlist, setPlaylist] = useState({});
    const [playback,  setPlayback]  = useState({ status: 'stopped' });
    const [isSyncing, setIsSyncing] = useState(false);
    const [wtLoading, setWtLoading] = useState(false);
    const [countdown, setCountdown] = useState(null); // seconds until start

    // ── Setup: join room, subscribe to all Gun nodes ──────────────────────────
    useEffect(() => {
        // Get/save room name for the rooms list
        p2pService.getRoom(roomId, (data) => {
            if (data && data.name) {
                setRoom(data);
                addJoinedRoom(roomId, data.name);
            }
        });

        const userName = storedUserName || `User_${Math.floor(Math.random() * 1000)}`;
        const { userId, unsubscribe } = p2pService.joinRoom(roomId, { name: userName });
        setMyUserId(userId);

        // Ensure self is always visible (merge, don't replace)
        setUsers(prev => ({ ...prev, [userId]: { name: userName, id: userId, lastSeen: Date.now() } }));

        // Listen for ping measurements
        p2pService.listenPings(roomId, userId);

        // Subscribe users — get existing first (once), then listen for updates (on)
        const unsubUsers = p2pService.subscribeUsers(roomId, (user, id) => {
            if (user && user.name) {
                setUsers(prev => ({ ...prev, [id]: { ...prev[id], ...user } }));
            } else if (user === null) {
                setUsers(prev => { const n = { ...prev }; delete n[id]; return n; });
            }
        });

        // Subscribe playlist
        const unsubPlaylist = p2pService.subscribePlaylist(roomId, (item, id) => {
            if (item && item.url) setPlaylist(prev => ({ ...prev, [id]: item }));
        });

        // Subscribe playback state (Gun)
        const unsubPlayback = p2pService.subscribePlayback(roomId, (data) => {
            if (data) setPlayback(data);
        });

        // Subscribe to real-time commands (Trystero)
        p2pService.onPlaybackCommand((data) => {
            console.log('[Room] Received real-time P2P command:', data.status);
            if (data) setPlayback(data);
        });

        // Remove users who leave the Trystero mesh
        p2pService.onPeerLeave((trysteroId) => {
            p2pService.removeUserByTrysteroId(roomId, trysteroId);
        });

        return () => {
            unsubscribe();
            if (unsubUsers && unsubUsers.off) unsubUsers.off();
            if (unsubPlaylist && unsubPlaylist.off) unsubPlaylist.off();
            if (unsubPlayback && unsubPlayback.off) unsubPlayback.off();
        };
    }, [roomId]);

    // ── Synchronized playback ─────────────────────────────────────────────────
    useEffect(() => {
        if (!playback || !playback.magnet) return;

        const player = document.getElementById('room-video-player');
        if (!player) return;

        // ── Stale session guard ──────────────────────────────────────────────
        // If serverTime is older than 10 min and status is 'playing', it's
        // leftover state from a previous session. Reset to avoid bad seek targets.
        const STALE_MS = 10 * 60 * 1000;
        if (playback.status === 'playing' && playback.serverTime &&
            Date.now() - playback.serverTime > STALE_MS) {
            console.warn('[Room] Stale playback detected (serverTime too old) — resetting.');
            p2pService.updatePlayback(roomId, {
                status: 'paused',
                magnet: playback.magnet,
                currentTime: 0,
                timestamp: Date.now()
            });
            return;
        }

        // ── Non-magnet URL: only magnets can be played in the video player ──────
        // Only non-magnet URLs skip the player — they're handled elsewhere
        if (!playback.magnet.startsWith('magnet:')) return;

        // Load source if changed — WebTorrent sets player.src which triggers
        // browser 'seeked' events internally. We suppress those with sourceLoading.
        let sourceLoading = false;
        if (player.dataset.src !== playback.magnet) {
            sourceLoading = true;
            player.dataset.src = playback.magnet;
            setWtLoading(true);
            p2pService.stream(playback.magnet, player);
            setTimeout(() => { sourceLoading = false; }, 3000);
        }

        // ── Helper: target playback position right now ──────────────────────
        const getTarget = () => {
            const base = Number(playback.currentTime) || 0;
            if (playback.status !== 'playing') return base;
            
            // Get our offset relative to the sender
            // Note: in a simple 1-to-1 it's easy. In a room, we use the average
            // or just the offset of the last person who updated.
            const offset = 0; // we'll use local time for now, but apply drift compensation
            
            const now = Date.now();
            const targetStart = Number(playback.serverTime) || now;
            const elapsedSinceStart = (now - targetStart) / 1000;
            
            return Math.max(0, base + elapsedSinceStart);
        };

        // ── Flag to distinguish programmatic seeks (sync) from user seeks
        let programmaticSeek = false;
        const safeSeek = (t) => {
            if (Math.abs(player.currentTime - t) < 0.2) return; 
            console.log(`[Sync] Seeking to ${t.toFixed(2)}s`);
            programmaticSeek = true;
            player.currentTime = t;
            setTimeout(() => { programmaticSeek = false; }, 2000); 
        };

        // ── PAUSED ──────────────────────────────────────────────────────────
        if (playback.status === 'paused') {
            if (!player.paused) {
                console.log('[Sync] Pausing player');
                player.pause();
            }
            const t = Number(playback.currentTime) || 0;
            if (Math.abs(player.currentTime - t) > 0.2) {
                console.log(`[Sync] Correcting pause position to ${t}`);
                safeSeek(t);
            }
            return; 
        }

        if (playback.status !== 'playing') return;

        // ── PLAYING ─────────────────────────────────────────────────────────

        // User manually scrubbed → broadcast new position to all peers
        // Ignore: 1) programmatic seeks from sync loop, 2) WebTorrent's internal
        // seeks that happen while the source is being set up (sourceLoading guard)
        const onSeeked = () => {
            if (programmaticSeek || sourceLoading) return;
            console.log('[Room] User seeked to', player.currentTime.toFixed(2));
            p2pService.updatePlayback(roomId, {
                status: playback.status || 'playing',
                magnet: playback.magnet || '',
                title: playback.title || '',
                currentTime: player.currentTime,
                serverTime: Date.now(),
            });
        };
        player.addEventListener('seeked', onSeeked);

        const onEnded = () => {
            if (playback.status === 'playing') {
                console.log('[Room] Playback ended, stopping for everyone');
                p2pService.updatePlayback(roomId, {
                    status: 'stopped',
                    magnet: playback.magnet || '',
                    title: playback.title || '',
                    currentTime: 0,
                    serverTime: Date.now(),
                });
            }
        };
        player.addEventListener('ended', onEnded);

        const now = Date.now();
        const serverTime = playback.serverTime || now;

        // ── Wait for player to have media data, then seek+play ───────────────
        // p2pService.stream() is async: client.add() → callback → file.streamTo()
        // → player.src is set. Until then readyState=0 and any seek/play is a no-op.
        // We use canplay as the gate; if already loaded we fire immediately.
        let startTimer = null;

        const beginPlayback = () => {
            setWtLoading(false);
            const delay = Math.max(0, serverTime - Date.now());
            if (delay > 0) {
                console.log(`[Room] Scheduled start in ${delay}ms`);
                startTimer = setTimeout(() => {
                    const t = getTarget();
                    safeSeek(t);
                    player.play().catch(e => console.warn('[Room] Autoplay blocked:', e));
                }, delay);
            } else {
                // Late joiner or immediate start — seek to current position and play
                const t = getTarget();
                if (Math.abs(player.currentTime - t) > 0.5) safeSeek(t);
                if (player.paused) player.play().catch(e => console.warn('[Room] Autoplay blocked:', e));
            }
        };

        if (player.readyState >= 2) {
            // Media already loaded (e.g. same torrent, playback state changed)
            beginPlayback();
        } else {
            // Wait for WebTorrent to set src and buffer first data, then start.
            // Add a timeout so the UI doesn't hang forever if there are no peers.
            player.addEventListener('canplay', beginPlayback, { once: true });
            const noDataTimer = setTimeout(() => {
                player.removeEventListener('canplay', beginPlayback);
                console.warn('[Room] canplay timeout — no WebTorrent peers? Check trackers.');
                setIsSyncing(false);
                // Show status in player so user knows what's happening
                const stats = p2pService.getTorrentStats(playback.magnet);
                if (stats && stats.peers === 0) {
                    console.warn('[Room] 0 peers for magnet — torrent may have no seeders');
                }
            }, 45000);
            // Clean up the timeout if canplay fires normally
            player.addEventListener('canplay', () => clearTimeout(noDataTimer), { once: true });
        }

        // ── Sync loop: gentle drift correction every 2 seconds ──────────────
        const syncLoop = setInterval(() => {
            if (player.paused) return;
            const target = getTarget();
            const drift = target - player.currentTime;
            if (Math.abs(drift) > 5) {
                safeSeek(target);
                setIsSyncing(true);
            } else if (Math.abs(drift) > 0.5) {
                player.playbackRate = drift > 0 ? 1.05 : 0.95;
                setIsSyncing(true);
            } else {
                player.playbackRate = 1.0;
                setIsSyncing(false);
            }
        }, 2000);

        return () => {
            clearTimeout(startTimer);
            clearInterval(syncLoop);
            player.removeEventListener('canplay', beginPlayback);
            player.removeEventListener('seeked', onSeeked);
            player.playbackRate = 1.0;
        };
    }, [playback]);

    // Only magnet links are playable in the room video player.
    const isMagnet = (url) => url && url.startsWith('magnet:');

    // ── Handlers ──────────────────────────────────────────────────────────────
    const handlePlayItem = async (item) => {
        if (!isMagnet(item.url)) {
            window.open(item.url, '_blank');
            return;
        }
        // Measure max ping → schedule synchronized start
        const otherUsers = Object.keys(users).filter(id => id !== myUserId);
        const pings = await Promise.all(
            otherUsers.map(id => p2pService.measurePing(roomId, id).catch(() => 300))
        );
        const maxPing = pings.length ? Math.max(...pings) : 0;
        // serverTime = moment everyone should start playing
        const serverTime = Date.now() + maxPing + 800;

        p2pService.updatePlayback(roomId, {
            status: 'playing',
            magnet: item.url,
            title: item.title,
            currentTime: 0,
            serverTime,           // when to start (future timestamp)
        });
    };

    const handlePause = () => {
        const player = document.getElementById('room-video-player');
        const pos = player ? player.currentTime : (playback.currentTime || 0);
        p2pService.updatePlayback(roomId, {
            status: 'paused',
            magnet: playback.magnet || '',
            title: playback.title || '',
            currentTime: pos,
            serverTime: Date.now(),
        });
    };

    const handleResume = () => {
        const player = document.getElementById('room-video-player');
        const currentPos = player ? player.currentTime : (playback.currentTime || 0);
        // Small delay so all peers receive the message before playback starts
        p2pService.updatePlayback(roomId, {
            status: 'playing',
            magnet: playback.magnet || '',
            title: playback.title || '',
            currentTime: currentPos,
            serverTime: Date.now() + 800,  // 800ms sync window for high-latency peers
        });
    };

    const addToPlaylist = () => {
        const url = prompt('Magnet-ссылка / URL стриминга');
        if (!url) return;
        const title = prompt('Название', 'Без названия');
        const item = { url, title: title || 'Без названия', type: url.startsWith('magnet:') ? 'magnet' : 'stream' };
        p2pService.addToPlaylist(roomId, item);
        setPlaylist(prev => ({ ...prev, ['opt-' + Date.now()]: item }));
    };

    // ── Derived state ─────────────────────────────────────────────────────────
    const visibleUsers = Object.entries(users).filter(([id, user]) => {
        if (id === myUserId) return true;
        if (!user || !user.name) {
            if (user) console.log('[Room] Filtering user without name:', id, user);
            return false;
        }
        // Heartbeat is every 15s; allow 45s before considering stale
        const delta = Date.now() - (user.lastSeen || 0);
        const stale = delta > 45000;
        if (stale) console.log('[Room] Filtering stale user:', user.name, 'delta:', (delta/1000).toFixed(0), 's');
        return !stale;
    });

    if (!room) return html`<div style="display:flex; justify-content:center; padding:4rem;"><div class="loading"></div></div>`;

    return html`
        <div class="room-page">
            <!-- Header -->
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2rem; flex-wrap:wrap; gap:1rem;">
                <div>
                    <h1 style="margin:0 0 4px;">${room.name}</h1>
                    <div style="font-size:0.75rem; opacity:0.45; font-family:monospace;">${roomId}</div>
                </div>
                <div style="display:flex; gap:10px; align-items:center;">
                    ${isSyncing && html`<span style="color:var(--accent-color); font-size:0.8rem; font-weight:bold; animation:pulse 1s infinite;">● ${i18n.t('syncing')}</span>`}
                    <button onClick=${() => {
                        const newName = prompt('Ваше имя', users[myUserId]?.name || '');
                        if (newName) { localStorage.setItem('userName', newName); window.location.reload(); }
                    }} class="glass" style="padding:5px 15px; border-radius:20px; color:white; cursor:pointer;">
                        👤 ${users[myUserId]?.name || '...'}
                    </button>
                </div>
            </div>

            <div style="display:grid; grid-template-columns: 2fr 1fr; gap:2rem;">
                <!-- Left: Player + Playlist -->
                <div>
                    <div class="glass" style="border-radius:12px; overflow:hidden; margin-bottom:1.5rem;">
                        <div style="position:relative;">
                            <video id="room-video-player" controls style="width:100%; display:block; background:#000; min-height:200px;"></video>
                            ${wtLoading && html`
                                <div style="position:absolute; inset:0; background:rgba(0,0,0,0.7); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; pointer-events:none;">
                                    <div class="loading"></div>
                                    <div style="font-size:0.85rem; opacity:0.7;">Подключение к пирам WebTorrent...</div>
                                    <div style="font-size:0.72rem; opacity:0.4;">${playback.title || ''}</div>
                                </div>
                            `}
                            ${countdown && html`
                                <div style="position:absolute; inset:0; background:rgba(0,0,0,0.4); display:flex; flex-direction:column; align-items:center; justify-content:center; pointer-events:none; z-index:10;">
                                    <div style="font-size:3rem; font-weight:800; color:white; text-shadow: 0 0 20px rgba(0,0,0,0.5);">${countdown}</div>
                                    <div style="font-size:0.8rem; opacity:0.8; letter-spacing:1px; text-transform:uppercase;">Синхронный старт...</div>
                                </div>
                            `}
                        </div>
                        <div style="padding:12px 16px; display:flex; justify-content:space-between; align-items:center;">
                            <div style="font-weight:600; font-size:0.95rem;">${playback.title || 'Нет воспроизведения'}</div>
                            <div style="display:flex; gap:8px;">
                                ${playback.status === 'playing' ? html`
                                    <button onClick=${handlePause} class="glass" style="padding:5px 14px; border-radius:6px; color:white; cursor:pointer; font-size:0.8rem;">⏸ Пауза для всех</button>
                                ` : playback.magnet ? html`
                                    <button onClick=${handleResume} class="glass" style="padding:5px 14px; border-radius:6px; color:white; cursor:pointer; font-size:0.8rem;">▶ Продолжить для всех</button>
                                ` : ''}
                            </div>
                        </div>
                    </div>

                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
                        <h3 style="margin:0;">${i18n.t('playlist')}</h3>
                        <button onClick=${addToPlaylist} class="glass" style="padding:6px 16px; border-radius:8px; color:white; cursor:pointer; font-size:0.85rem;">+ ${i18n.t('add_to_playlist')}</button>
                    </div>
                    <div class="glass" style="border-radius:12px; overflow:hidden;">
                        ${Object.entries(playlist).length === 0
                            ? html`<p style="opacity:0.45; text-align:center; padding:2rem; margin:0;">Плейлист пуст. Добавьте первый трек →</p>`
                            : Object.entries(playlist).map(([id, item]) => html`
                                <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-bottom:1px solid rgba(255,255,255,0.06); transition:background 0.15s;"
                                    onMouseEnter=${e => e.currentTarget.style.background='rgba(255,255,255,0.04)'}
                                    onMouseLeave=${e => e.currentTarget.style.background=''}>
                                    <div style="overflow:hidden; margin-right:12px;">
                                        <div style="font-weight:600; font-size:0.9rem; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">${item.title}</div>
                                        <div style="font-size:0.7rem; opacity:0.4; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; max-width:280px;">${item.url}</div>
                                    </div>
                                    <button onClick=${() => handlePlayItem(item)} style="flex-shrink:0; background:${isMagnet(item.url) ? 'var(--accent-color)' : '#2a6496'}; color:white; border:none; padding:6px 16px; border-radius:6px; cursor:pointer; font-weight:600; font-size:0.85rem;">
                                        ${isMagnet(item.url) ? '▶ ' + i18n.t('play') : '↗ Открыть'}
                                    </button>
                                </div>
                            `)
                        }
                    </div>
                </div>

                <!-- Right: Users -->
                <div>
                    <section class="glass" style="padding:1.2rem; border-radius:12px;">
                        <h3 style="margin:0 0 1rem;">${i18n.t('users')} (${visibleUsers.length})</h3>
                        <div style="display:grid; gap:0.5rem;">
                            ${visibleUsers.map(([id, user]) => html`
                                <div style="display:flex; align-items:center; gap:10px; padding:8px 10px; background:rgba(255,255,255,0.03); border-radius:10px; border:${id === myUserId ? '1px solid rgba(229,9,20,0.5)' : '1px solid transparent'};">
                                    <div style="width:32px; height:32px; border-radius:50%; background:var(--accent-color); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:0.85rem; flex-shrink:0;">
                                        ${(user.name || '?')[0].toUpperCase()}
                                    </div>
                                    <div>
                                        <div style="font-size:0.9rem; font-weight:${id === myUserId ? 600 : 400};">${user.name} ${id === myUserId ? '(Вы)' : ''}</div>
                                        <div style="font-size:0.7rem; color:#4caf50;">● Online</div>
                                    </div>
                                </div>
                            `)}
                        </div>
                    </section>

                    <!-- Share link -->
                    <div class="glass" style="padding:1rem; border-radius:12px; margin-top:1rem;">
                        <div style="font-size:0.75rem; opacity:0.6; margin-bottom:6px;">Пригласительная ссылка</div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <input readonly value=${location.origin + location.pathname + '#room/' + roomId}
                                   style="flex:1; background:rgba(255,255,255,0.05); border:1px solid #333; color:white; padding:6px 10px; border-radius:6px; font-size:0.72rem; font-family:monospace;"
                                   onClick=${e => e.target.select()} />
                            <button onClick=${() => {
                                navigator.clipboard.writeText(location.origin + location.pathname + '#room/' + roomId);
                            }} class="glass" style="padding:6px 10px; border-radius:6px; color:white; cursor:pointer; font-size:0.75rem; white-space:nowrap;">
                                Копировать
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

render(html`<${App} />`, document.getElementById('app'));
