// api/update-data.js - Cron job to fetch and cache NHL data daily
import fs from 'fs/promises';
import path from 'path';

export default async function handler(req, res) {
  // Verify this is from Vercel Cron (security)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('Starting daily NHL data update...');
    const season = '20252026';
    
    // Step 1: Fetch all player stats
    console.log('Fetching player stats...');
    const statsUrl = `https://api.nhle.com/stats/rest/en/skater/summary?limit=1000&start=0&cayenneExp=seasonId=${season}`;
    const statsResponse = await fetch(statsUrl);
    const statsData = await statsResponse.json();
    
    const allPlayers = statsData.data || [];
    const playersWithGames = allPlayers.filter(p => (p.gamesPlayed || 0) > 0);
    
    console.log(`Found ${playersWithGames.length} players with games played`);
    
    // Step 2: Fetch game logs for ALL players with games
    console.log(`Fetching game logs for ALL ${playersWithGames.length} players...`);
    
    const gameLogsData = {};
    let successCount = 0;
    let errorCount = 0;
    
    // Process in batches to show progress
    const batchSize = 50;
    for (let i = 0; i < playersWithGames.length; i += batchSize) {
      const batch = playersWithGames.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(playersWithGames.length / batchSize)}...`);
      
      await Promise.all(batch.map(async (player) => {
        try {
          const gameLogUrl = `https://api-web.nhle.com/v1/player/${player.playerId}/game-log/${season}/2`;
          const gameLogResponse = await fetch(gameLogUrl);
          
          if (gameLogResponse.ok) {
            const gameLog = await gameLogResponse.json();
            gameLogsData[player.playerId] = gameLog;
            successCount++;
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
    
    console.log(`Successfully loaded ${successCount} game logs, ${errorCount} errors`);
    
    // Step 3: Create response data (we'll return it directly, not save to file)
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
    
    console.log('Data collection completed!');
    console.log(`Total size: ${JSON.stringify(cacheData).length / 1024 / 1024} MB`);
    
    return res.status(200).json({
      success: true,
      message: 'NHL data updated successfully',
      lastUpdated: cacheData.lastUpdated,
      stats: cacheData.stats,
      // Return the actual data so we can use it
      data: cacheData
    });
    
  } catch (error) {
    console.error('Error updating NHL data:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
