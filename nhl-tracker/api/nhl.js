// api/nhl.js - Vercel Serverless Function
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { endpoint } = req.query;

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint parameter' });
  }

  try {
    const nhlApiUrl = `https://api-web.nhle.com${endpoint}`;
    console.log('Fetching from NHL API:', nhlApiUrl);

    const response = await fetch(nhlApiUrl);

    if (!response.ok) {
      throw new Error(`NHL API returned status ${response.status}`);
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (error) {
    console.error('Error fetching from NHL API:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch from NHL API',
      message: error.message 
    });
  }
}