// api/update-data.js - Cron job to fetch and cache NHL data + betting odds daily
import { put } from '@vercel/blob';

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
    
    // Step 3: Fetch betting odds from The Odds API
    console.log('Fetching betting odds from The Odds API...');
    let bettingOdds = {};
    let oddsError = null;
    
    try {
      const oddsApiKey = process.env.ODDS_API_KEY;
      
      if (oddsApiKey && oddsApiKey !== 'YOUR_ODDS_API_KEY_HERE') {
        // First, try to get upcoming NHL events
        const eventsUrl = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events?apiKey=${oddsApiKey}`;
        console.log('Checking for upcoming NHL events...');
        
        const eventsResponse = await fetch(eventsUrl);
        
        if (!eventsResponse.ok) {
          throw new Error(`Events API returned status ${eventsResponse.status}: ${await eventsResponse.text()}`);
        }
        
        const events = await eventsResponse.json();
        console.log(`Found ${events.length} upcoming NHL events`);
        
        if (events.length === 0) {
          oddsError = 'No upcoming NHL games found - likely off-season or no games scheduled';
          console.log(oddsError);
        } else {
          // Sort events by commence_time (soonest first)
          events.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
          
          // Fetch player props using the correct endpoint
          // We need to fetch props for each event/game individually
          console.log(`Fetching player props for ${Math.min(events.length, 10)} soonest games...`);
          
          for (const event of events.slice(0, 10)) { // Limit to first 10 games to save API calls
            try {
              const eventId = event.id;
              const gameDate = new Date(event.commence_time).toLocaleString();
              const propsUrl = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events/${eventId}/odds?apiKey=${oddsApiKey}&regions=us&markets=player_points,player_goals,player_assists,player_shots_on_goal&oddsFormat=american`;
              
              console.log(`Fetching props for: ${event.home_team} vs ${event.away_team} (${gameDate})`);
              
              const propsResponse = await fetch(propsUrl);
              
              if (!propsResponse.ok) {
                console.log(`Failed to fetch props for event ${eventId}: ${propsResponse.status}`);
                continue;
              }
              
              const propsData = await propsResponse.json();
              
              // Process player props from bookmakers
              // Only take the first bookmaker's odds for consistency
              const bookmaker = propsData.bookmakers?.[0];
              
              if (!bookmaker) {
                console.log(`No bookmakers found for ${event.home_team} vs ${event.away_team}`);
                continue;
              }
              
              console.log(`Processing odds from ${bookmaker.title}`);
              
              bookmaker.markets?.forEach(market => {
                market.outcomes?.forEach(outcome => {
                  const playerName = outcome.description;
                  
                  if (!playerName) return;
                  
                  if (!bettingOdds[playerName]) {
                    bettingOdds[playerName] = {};
                  }
                  
                  // Only store 'Over' outcomes (we want the over line)
                  // Only store if we don't already have a line for this stat (first game/first line wins)
                  if (outcome.name === 'Over' && outcome.point !== undefined) {
                    if (market.key === 'player_points' && !bettingOdds[playerName].points) {
                      bettingOdds[playerName].points = {
                        line: outcome.point,
                        odds: outcome.price,
                        bookmaker: bookmaker.title,
                        game: `${event.home_team} vs ${event.away_team}`,
                        gameTime: event.commence_time
                      };
                    } else if (market.key === 'player_goals' && !bettingOdds[playerName].goals) {
                      bettingOdds[playerName].goals = {
                        line: outcome.point,
                        odds: outcome.price,
                        bookmaker: bookmaker.title,
                        game: `${event.home_team} vs ${event.away_team}`,
                        gameTime: event.commence_time
                      };
                    } else if (market.key === 'player_assists' && !bettingOdds[playerName].assists) {
                      bettingOdds[playerName].assists = {
                        line: outcome.point,
                        odds: outcome.price,
                        bookmaker: bookmaker.title,
                        game: `${event.home_team} vs ${event.away_team}`,
                        gameTime: event.commence_time
                      };
                    } else if (market.key === 'player_shots_on_goal' && !bettingOdds[playerName].shots) {
                      bettingOdds[playerName].shots = {
                        line: outcome.point,
                        odds: outcome.price,
                        bookmaker: bookmaker.title,
                        game: `${event.home_team} vs ${event.away_team}`,
                        gameTime: event.commence_time
                      };
                    }
                  }
                });
              });
              
              // Small delay to avoid rate limiting
              await new Promise(resolve => setTimeout(resolve, 200));
              
            } catch (eventError) {
              console.error(`Error fetching props for event ${event.id}:`, eventError.message);
            }
          }
          
          console.log(`Loaded betting lines for ${Object.keys(bettingOdds).length} players`);
        }
      } else {
        oddsError = 'ODDS_API_KEY not set in environment variables';
        console.log(oddsError);
      }
    } catch (error) {
      oddsError = error.message;
      console.error('Error fetching odds:', error);
    }
    
    // Step 4: Save everything to Vercel Blob storage (persists permanently!)
    const cacheData = {
      lastUpdated: new Date().toISOString(),
      season: season,
      allPlayers: playersWithGames,
      gameLogs: gameLogsData,
      bettingOdds: bettingOdds,
      stats: {
        totalPlayers: playersWithGames.length,
        gameLogsLoaded: successCount,
        errors: errorCount,
        bettingLinesLoaded: Object.keys(bettingOdds).length,
        oddsError: oddsError
      }
    };
    
    console.log('Saving to Vercel Blob storage...');
    
    // Save to Vercel Blob (persists across all function instances and time!)
    const blob = await put('nhl-cache.json', JSON.stringify(cacheData), {
      access: 'public',
      addRandomSuffix: false,
    });
    
    console.log('Data cached successfully to Blob:', blob.url);
    
    return res.status(200).json({
      success: true,
      message: 'NHL data updated successfully',
      lastUpdated: cacheData.lastUpdated,
      stats: cacheData.stats,
      blobUrl: blob.url
    });
    
  } catch (error) {
    console.error('Error updating NHL data:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
