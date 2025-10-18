// api/get-data.js - Serve cached NHL data from Vercel Blob
import { list } from '@vercel/blob';

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
    // Force fresh fetch by checking timestamp
    console.log('Fetching fresh data from Vercel Blob...');
    
    // List blobs to find our cache file
    const { blobs } = await list({ prefix: 'nhl-cache.json' });
    
    if (blobs.length === 0) {
      throw new Error('No cache found in Blob storage');
    }
    
    const blobUrl = blobs[0].url;
    console.log('Found cache in Blob, fetching:', blobUrl);
    
    // Add timestamp to bypass any CDN caching
    const fetchUrl = `${blobUrl}?t=${Date.now()}`;
    const blobResponse = await fetch(fetchUrl);
    const cacheData = await blobResponse.json();
    
    console.log('Loaded from Blob cache');
    console.log('Last updated:', cacheData.lastUpdated);
    console.log('Players:', cacheData.stats?.totalPlayers || cacheData.allPlayers?.length);
    console.log('Goalies:', cacheData.stats?.totalGoalies || cacheData.allGoalies?.length);
    console.log('Team shot data:', cacheData.teamShotData?.length);
    
    // Set cache headers to allow browser caching for 5 minutes
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    
    return res.status(200).json(cacheData);
    
  } catch (error) {
    console.error('Error serving cached data:', error);
    return res.status(500).json({
      error: 'Failed to serve data',
      message: error.message
    });
  }
}
