// api/get-data.js - Serve cached NHL data

// Global variable to store data (persists across requests in the same instance)
let cachedData = null;
let lastFetchTime = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Allow POST from the update-data cron job to store data
  if (req.method === 'POST') {
    try {
      const data = req.body;
      cachedData = data;
      lastFetchTime = Date.now();
      console.log('Data cached via POST:', {
        players: data.allPlayers?.length,
        gameLogs: Object.keys(data.gameLogs || {}).length
      });
      return res.status(200).json({ success: true, message: 'Data cached' });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Check if we have cached data and it's fresh
    if (cachedData && lastFetchTime && (Date.now() - lastFetchTime < CACHE_DURATION)) {
      console.log('Serving from cache, age:', Math.round((Date.now() - lastFetchTime) / 1000 / 60), 'minutes');
      return res.status(200).json(cachedData);
    }
    
    // No cache or stale - fetch fresh data
    console.log('No cache found or cache stale, fetching fresh data...');
    
    const season = '20252026';
    
    // Fetch player stats only (game logs would take too long)
    const statsUrl = `https://api.nhle.com/stats/rest/en/skater/summary?limit=1000&start=0&cayenneExp=seasonId=${season}`;
    const statsResponse = await fetch(statsUrl);
    const statsData = await statsResponse.json();
    
    const allPlayers = statsData.data || [];
    const playersWithGames = allPlayers.filter(p => (p.gamesPlayed || 0) > 0);
    
    // Return just players without game logs
    const freshData = {
      lastUpdated: new Date().toISOString(),
      season: season,
      allPlayers: playersWithGames,
      gameLogs: {},
      stats: {
        totalPlayers: playersWithGames.length,
        gameLogsLoaded: 0,
        note: 'Trigger /api/update-data to fetch all game logs'
      }
    };
    
    return res.status(200).json(freshData);
    
  } catch (error) {
    console.error('Error serving data:', error);
    return res.status(500).json({
      error: 'Failed to serve data',
      message: error.message
    });
  }
}
