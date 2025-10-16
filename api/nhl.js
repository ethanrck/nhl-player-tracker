// api/nhl.js - Vercel Serverless Function
// This handles all NHL API requests and adds CORS headers

export default async function handler(req, res) {
  // Enable CORS for all origins
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { endpoint } = req.query;

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint parameter' });
  }

  try {
    // Build the NHL API URL - handle both api-web and stats endpoints
    let nhlApiUrl;
    if (endpoint.startsWith('/stats/rest/')) {
      nhlApiUrl = `https://api.nhle.com${endpoint}`;
    } else {
      nhlApiUrl = `https://api-web.nhle.com${endpoint}`;
    }
    
    console.log('Fetching from NHL API:', nhlApiUrl);

    // Fetch from NHL API
    const response = await fetch(nhlApiUrl);

    if (!response.ok) {
      throw new Error(`NHL API returned status ${response.status}`);
    }

    const data = await response.json();

    // Return the data with CORS headers
    return res.status(200).json(data);

  } catch (error) {
    console.error('Error fetching from NHL API:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch from NHL API',
      message: error.message 
    });
  }
}
