// api/get-data.js - Serve cached NHL data from Vercel Blob
import { list } from '@vercel/blob';

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
      console.log('Betting lines in cache:', cacheData.stats.bettingLinesLoaded);
      
      // Store in memory for faster subsequent requests
      memoryCache = cacheData;
      cacheTimestamp = now;
      
      return res.status(200).json(cacheData);
      
    } catch (blobError) {
      // Cache doesn't exist yet - return error message
      console.log('No cache found in Blob storage');
      console.error('Blob error:', blobError.message);
      
      return res.status(503).json({
        error: 'No cached data available',
        message: 'Please run /api/update-data to populate the cache',
        details: blobError.message
      });
    }
    
  } catch (error) {
    console.error('Error serving cached data:', error);
    return res.status(500).json({
      error: 'Failed to serve data',
      message: error.message
    });
  }
}
