// api/get-data.js - Serve cached NHL data
import fs from 'fs/promises';

// In-memory cache (persists across requests in same instance)
let memoryCache = null;

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Check memory cache first
    if (memoryCache) {
      console.log('Serving from memory cache');
      return res.status(200).json(memoryCache);
    }
    
    // Try to load from file system
    try {
      const cachePath = '/tmp/nhl-cache.json';
      const cacheContent = await fs.readFile(cachePath, 'utf-8');
      const cacheData = JSON.parse(cacheContent);
      
      console.log('Loaded from file cache, last updated:', cacheData.lastUpdated);
      
      // Store in memory for faster subsequent requests
      memoryCache = cacheData;
      
      return res.status(200).json(cacheData);
    } catch (fileError) {
      // Cache doesn't exist yet - fetch fresh data
      console.log('No cache found, fetching fresh data...');
      
      const season = '20252026';
      
      // Fetch player stats
      const statsUrl = `https://api.nhle.com/stats/rest/en/skater/summary?limit=1000&start=0&cayenneExp=seasonId=${season}`;
      const statsResponse = await fetch(statsUrl);
      const statsData = await statsResponse.json();
      
      const allPlayers = statsData.data || [];
      const playersWithGames = allPlayers.filter(p => (p.gamesPlayed || 0) > 0);
      
      // Return just the players without game logs for now
      const freshData = {
        lastUpdated: new Date().toISOString(),
        season: season,
        allPlayers: playersWithGames,
        gameLogs: {},
        stats: {
          totalPlayers: playersWithGames.length,
          gameLogsLoaded: 0,
          note: 'Run /api/update-data to fetch game logs'
        }
      };
      
      // Cache it
      memoryCache = freshData;
      
      return res.status(200).json(freshData);
    }
    
  } catch (error) {
    console.error('Error serving cached data:', error);
    return res.status(500).json({
      error: 'Failed to serve data',
      message: error.message
    });
  }
}