const DEFAULT_TMDB_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI2MDU0ZTk1NzQ2YjA1M2ZmN2U3ZTRlMGU0NmQ4YWIzYyIsIm5iZiI6MTQwNDg4OTI1Ni4wLCJzdWIiOiI1M2JjZThhN2MzYTM2ODRjZTkwMDBjZjIiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.mFTReryzXkY4SbbPGydkuSE65kfpajhVLTqhPuGq_mc';

export const config = {
    getTMDBKey: () => {
        return localStorage.getItem('tmdb_api_key') || DEFAULT_TMDB_KEY;
    },
    setTMDBKey: (key) => {
        localStorage.setItem('tmdb_api_key', key);
    },
    resetTMDBKey: () => {
        localStorage.removeItem('tmdb_api_key');
    },
    tmdbBaseUrl: 'https://api.themoviedb.org/3',
    tmdbImageBase: 'https://image.tmdb.org/t/p/w500',
    gunRelays: [
        'https://gun-relay.crm114.workers.dev/gun',
        'https://peer.wallie.io/gun',
        'https://gunjs.herokuapp.com/gun',
    ],
    trackers: [
        'wss://tracker.openwebtorrent.com',
        'wss://tracker.webtorrent.dev',
        'wss://tracker.files.fm:7073/announce',
        // 'wss://tracker.btorrent.xyz',
        // 'wss://tracker.files.fm:7073/announce',
        // 'wss://tracker.fastcast.nz',
        // 'wss://tracker.gbitt.info:443/announce'
    ]
};
