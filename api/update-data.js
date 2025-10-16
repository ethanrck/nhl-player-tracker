// api/update-data.js - Cron job to fetch and cache NHL data daily
import fs from 'fs/promises';

export default async function handler(req, res) {
  // Verify this is from Vercel Cron (security)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('Starting daily NHL data update...');
    const season = '20252026'; // 2025-26 NHL Season
    
    // Step 1: Fetch ALL player stats (need to paginate)
    console.log('Fetching all player stats...');
    let allPlayers = [];
    let start = 0;
    const limit = 100;
    let hasMore = true;
    
    while (hasMore) {
      const statsUrl = `https://api.nhle.com/stats/rest/en/skater/summary?limit=${limit}&start=${start}&cayenneExp=seasonId=${season}`;
      console.log(`Fetching players ${start} to ${start + limit}...`);
      
      const statsResponse = await fetch(statsUrl);
      const statsData = await statsResponse.json();
      
      const players = statsData.data || [];
      
      if (players.length === 0) {
        hasMore = false;
      } else {
        allPlayers = allPlayers.concat(players);
        start += limit;
        
        // If we got fewer than limit, we've reached the end
        if (players.length < limit) {
          hasMore = false;
        }
      }
    }
    
    const playersWithGames = allPlayers.filter(p => (p.gamesPlayed || 0) > 0);
    
    console.log(`Found ${playersWithGames.length} players with games played out of ${allPlayers.length} total`);
    
    // Step 2: Fetch game logs for ALL players with games
    console.log(`Fetching game logs for ALL ${playersWithGames.length} players...`);
    
    const gameLogsData = {};
    let successCount = 0;
    let errorCount = 0;
    
    // Process in batches to show progress and avoid rate limiting
    const batchSize = 50;
    for (let i = 0; i < playersWithGames.length; i += batchSize) {
      const batch = playersWithGames.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(playersWithGames.length / batchSize);
      
      console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} players)...`);
      
      await Promise.all(batch.map(async (player) => {
        try {
          const gameLogUrl = `https://api-web.nhle.com/v1/player/${player.playerId}/game-log/${season}/2`;
          const gameLogResponse = await fetch(gameLogUrl);
          
          if (gameLogResponse.ok) {
            const gameLog = await gameLogResponse.json();
            if (gameLog && gameLog.gameLog && gameLog.gameLog.length > 0) {
              gameLogsData[player.playerId] = gameLog;
              successCount++;
            } else {
              errorCount++;
            }
          } else {
            errorCount++;
          }
        } catch (error) {
          console.error(`Error fetching game log for player ${player.playerId}:`, error.message);
          errorCount++;
        }
      }));
      
      // Small delay between batches to be nice to the API
      if (i + batchSize < playersWithGames.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log(`Successfully loaded ${successCount} game logs, ${errorCount} errors/empty`);
    
    // Step 3: Save to file system (Vercel /tmp directory)
    const cacheData = {
      lastUpdated: new Date().toISOString(),
      season: season,
      allPlayers: playersWithGames,
      gameLogs: gameLogsData,
      stats: {
        totalPlayers: playersWithGames.length,
        gameLogsLoaded: successCount,
        errors: errorCount
      }
    };
    
    // Save to /tmp (persists for duration of function execution)
    const cachePath = '/tmp/nhl-cache.json';
    await fs.writeFile(cachePath, JSON.stringify(cacheData));
    
    console.log('Data cached successfully!');
    
    return res.status(200).json({
      success: true,
      message: 'NHL data updated successfully',
      lastUpdated: cacheData.lastUpdated,
      stats: cacheData.stats
    });
    
  } catch (error) {
    console.error('Error updating NHL data:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
