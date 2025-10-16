// api/get-data.js - Serve cached NHL data from Vercel Blob
import { head, list } from '@vercel/blob';

// In-memory cache (persists across requests in same instance)
let memoryCache = null;
let cacheTimestamp = null;

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
    // Check memory cache first (valid for 5 minutes)
    const now = Date.now();
    if (memoryCache && cacheTimestamp && (now - cacheTimestamp) < 5 * 60 * 1000) {
      console.log('Serving from memory cache');
      return res.status(200).json(memoryCache);
    }
    
    // Try to load from Vercel Blob
    try {
      console.log('Checking Vercel Blob for cache...');
      
      // List blobs to find our cache file
      const { blobs } = await list({ prefix: 'nhl-cache.json' });
      
      if (blobs.length === 0) {
        throw new Error('No cache found in Blob storage');
      }
      
      const blobUrl = blobs[0].url;
      console.log('Found cache in Blob, fetching:', blobUrl);
      
      // Fetch the blob content
      const blobResponse = await fetch(blobUrl);
      const cacheData = await blobResponse.json();
      
      console.log('Loaded from Blob cache, last updated:', cacheData.lastUpdated);
      console.log('Players in cache:', cacheData.stats.totalPlayers);
      
      // Store in memory for faster subsequent requests
      memoryCache = cacheData;
      cacheTimestamp = now;
      
      return res.status(200).json(cacheData);
      
    } catch (blobError) {
      // Cache doesn't exist yet - fetch fresh data
      console.log('No cache found in Blob, fetching fresh player list...');
      console.error('Blob error:', blobError.message);
      
      const season = '20252026'; // 2025-26 NHL Season
      
      // Fetch ALL player stats (paginated)
      let allPlayers = [];
      let start = 0;
      const limit = 100;
      let hasMore = true;
      
      while (hasMore) {
        const statsUrl = `https://api.nhle.com/stats/rest/en/skater/summary?limit=${limit}&start=${start}&cayenneExp=seasonId=${season}`;
        const statsResponse = await fetch(statsUrl);
        const statsData = await statsResponse.json();
        
        const players = statsData.data || [];
        
        if (players.length === 0) {
          hasMore = false;
        } else {
          allPlayers = allPlayers.concat(players);
          start += limit;
          
          if (players.length < limit) {
            hasMore = false;
          }
        }
      }
      
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
          note: 'Run /api/update-data to fetch game logs and save to Blob storage'
        }
      };
      
      // Cache it
      memoryCache = freshData;
      cacheTimestamp = now;
      
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
