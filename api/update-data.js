// api/update-data.js - Cron job to fetch and cache NHL data + betting odds daily
import { put } from '@vercel/blob';

export default async function handler(req, res) {
  // Temporarily allow manual testing - REMOVE THIS IN PRODUCTION
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  
  if (req.method === 'GET' && req.query.manual === 'true') {
    console.log('Manual trigger - bypassing auth');
  } else if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized', auth: authHeader ? 'present' : 'missing' });
  }

  try {
    console.log('Starting daily NHL data update...');
    const season = '20252026'; // 2025-26 NHL Season

    // Step 1: Fetch ALL player stats (paginated)
    console.log('Fetching all player stats...');
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
        if (players.length < limit) hasMore = false;
      }
    }

    const playersWithGames = allPlayers.filter(p => (p.gamesPlayed || 0) > 0);
    console.log(`Found ${playersWithGames.length} active players`);

    // Step 1b: Fetch ALL goalie stats (paginated)
    console.log('Fetching all goalie stats...');
    let allGoalies = [];
    start = 0;
    hasMore = true;

    while (hasMore) {
      const goalieUrl = `https://api.nhle.com/stats/rest/en/goalie/summary?limit=${limit}&start=${start}&cayenneExp=seasonId=${season}`;
      const goalieResponse = await fetch(goalieUrl);
      const goalieData = await goalieResponse.json();
      const goalies = goalieData.data || [];

      if (goalies.length === 0) {
        hasMore = false;
      } else {
        allGoalies = allGoalies.concat(goalies);
        start += limit;
        if (goalies.length < limit) hasMore = false;
      }
    }

    const goaliesWithGames = allGoalies.filter(g => (g.gamesPlayed || 0) > 0);
    console.log(`Found ${goaliesWithGames.length} active goalies`);

    // Step 2: Fetch player game logs
    const gameLogsData = {};
    let successCount = 0;
    let errorCount = 0;

    const batchSize = 50;
    for (let i = 0; i < playersWithGames.length; i += batchSize) {
      const batch = playersWithGames.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async player => {
          try {
            const gameLogUrl = `https://api-web.nhle.com/v1/player/${player.playerId}/game-log/${season}/2`;
            const gameLogResponse = await fetch(gameLogUrl);
            if (gameLogResponse.ok) {
              const gameLog = await gameLogResponse.json();
              if (gameLog?.gameLog?.length > 0) {
                gameLogsData[player.playerId] = gameLog;
                successCount++;
              } else errorCount++;
            } else errorCount++;
          } catch (e) {
            errorCount++;
          }
        })
      );
      if (i + batchSize < playersWithGames.length) await new Promise(r => setTimeout(r, 500));
    }

    console.log(`Player game logs: ${successCount} success, ${errorCount} errors`);

    // Step 2b: Fetch goalie game logs
    const goalieGameLogsData = {};
    let goalieSuccessCount = 0;
    let goalieErrorCount = 0;

    for (let i = 0; i < goaliesWithGames.length; i += batchSize) {
      const batch = goaliesWithGames.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async goalie => {
          try {
            const gameLogUrl = `https://api-web.nhle.com/v1/player/${goalie.playerId}/game-log/${season}/2`;
            const gameLogResponse = await fetch(gameLogUrl);
            if (gameLogResponse.ok) {
              const gameLog = await gameLogResponse.json();
              if (gameLog?.gameLog?.length > 0) {
                goalieGameLogsData[goalie.playerId] = gameLog;
                goalieSuccessCount++;
              } else goalieErrorCount++;
            } else goalieErrorCount++;
          } catch (e) {
            goalieErrorCount++;
          }
        })
      );
      if (i + batchSize < goaliesWithGames.length) await new Promise(r => setTimeout(r, 500));
    }

    console.log(`Goalie game logs: ${goalieSuccessCount} success, ${goalieErrorCount} errors`);

    // Step 3: Fetch betting odds
    console.log('Fetching betting odds from The Odds API...');
    let bettingOdds = {};
    let oddsError = null;

    try {
      const oddsApiKey = process.env.ODDS_API_KEY;
      console.log('Odds API Key exists:', !!oddsApiKey);
      
      if (oddsApiKey && oddsApiKey !== 'YOUR_ODDS_API_KEY_HERE') {
        const eventsUrl = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events?apiKey=${oddsApiKey}`;
        console.log('Fetching events from:', eventsUrl.replace(oddsApiKey, 'KEY_HIDDEN'));
        
        const eventsResponse = await fetch(eventsUrl);
        console.log('Events response status:', eventsResponse.status);
        
        if (!eventsResponse.ok) {
          const errorText = await eventsResponse.text();
          throw new Error(`Events API error ${eventsResponse.status}: ${errorText}`);
        }

        const events = await eventsResponse.json();
        console.log('Total events found:', events.length);
        
        // Get current date in UTC
        const now = new Date();
        console.log('Current time (UTC):', now.toISOString());
        
        // Get games happening in the next 48 hours
        const fortyEightHoursFromNow = new Date(now.getTime() + (48 * 60 * 60 * 1000));
        
        const upcomingGames = events.filter(e => {
          const gameTime = new Date(e.commence_time);
          const isUpcoming = gameTime >= now && gameTime <= fortyEightHoursFromNow;
          if (isUpcoming) {
            console.log(`Including game: ${e.home_team} vs ${e.away_team} at ${gameTime.toISOString()}`);
          }
          return isUpcoming;
        });

        console.log(`Found ${upcomingGames.length} upcoming games in next 48 hours`);
        
        if (upcomingGames.length > 0) {
          upcomingGames.forEach(game => {
            console.log(`Game: ${game.home_team} vs ${game.away_team} at ${game.commence_time}`);
          });
        }

        const gamePromises = upcomingGames.map(async event => {
          const eventId = event.id;
          const propsUrl = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events/${eventId}/odds?apiKey=${oddsApiKey}&regions=us&markets=player_points,player_goal_scorer_anytime,player_assists,player_shots_on_goal,goalie_saves&oddsFormat=american`;
          console.log('Fetching props for event:', eventId, event.home_team, 'vs', event.away_team);
          
          try {
            const propsResponse = await fetch(propsUrl);
            console.log('Props response status:', propsResponse.status);
            
            if (!propsResponse.ok) {
              const errorText = await propsResponse.text();
              console.log('Props fetch failed for event:', eventId, 'Status:', propsResponse.status, 'Error:', errorText);
              return null;
            }
            
            const data = await propsResponse.json();
            console.log('Props data received for event:', eventId, 'Bookmakers:', data.bookmakers?.length || 0);
            return { event, data };
          } catch (e) {
            console.error('Error fetching props for event:', eventId, e.message);
            return null;
          }
        });

        console.log('Waiting for all props requests...');
        const allPropsData = await Promise.all(gamePromises);
        console.log('All props requests completed. Processing', allPropsData.filter(x => x).length, 'successful responses');
        
        let totalOutcomes = 0;
        let playersProcessed = 0;
        
        for (const result of allPropsData) {
          if (!result) {
            console.log('Skipping null result');
            continue;
          }
          const { event, data: propsData } = result;

          console.log(`\n=== Processing odds for: ${event.home_team} vs ${event.away_team} ===`);
          console.log('Bookmakers found:', propsData.bookmakers?.length || 0);

          const bookmaker = propsData.bookmakers?.[0];
          if (!bookmaker) {
            console.log('No bookmakers available for this game');
            continue;
          }

          console.log('Using bookmaker:', bookmaker.title);
          console.log('Markets available:', bookmaker.markets?.length || 0);
          
          if (bookmaker.markets) {
            bookmaker.markets.forEach(market => {
              console.log(`  Market: ${market.key}, Outcomes: ${market.outcomes?.length || 0}`);
            });
          }

          bookmaker.markets?.forEach(market => {
            market.outcomes?.forEach(outcome => {
              const playerName = outcome.description;
              if (!playerName) {
                console.log('    Skipping outcome without player name');
                return;
              }
              
              if (!bettingOdds[playerName]) {
                bettingOdds[playerName] = {};
                playersProcessed++;
              }

              totalOutcomes++;

              if (outcome.name === 'Over' && outcome.point !== undefined) {
                if (market.key === 'player_points' && !bettingOdds[playerName].points) {
                  console.log(`    Adding points line for ${playerName}: ${outcome.point}`);
                  bettingOdds[playerName].points = {
                    line: outcome.point,
                    odds: outcome.price,
                    bookmaker: bookmaker.title,
                    game: `${event.home_team} vs ${event.away_team}`,
                    gameTime: event.commence_time
                  };
                } else if (market.key === 'player_assists' && !bettingOdds[playerName].assists) {
                  console.log(`    Adding assists line for ${playerName}: ${outcome.point}`);
                  bettingOdds[playerName].assists = {
                    line: outcome.point,
                    odds: outcome.price,
                    bookmaker: bookmaker.title,
                    game: `${event.home_team} vs ${event.away_team}`,
                    gameTime: event.commence_time
                  };
                } else if (market.key === 'player_shots_on_goal' && !bettingOdds[playerName].shots) {
                  console.log(`    Adding shots line for ${playerName}: ${outcome.point}`);
                  bettingOdds[playerName].shots = {
                    line: outcome.point,
                    odds: outcome.price,
                    bookmaker: bookmaker.title,
                    game: `${event.home_team} vs ${event.away_team}`,
                    gameTime: event.commence_time
                  };
                } else if (market.key === 'goalie_saves' && !bettingOdds[playerName].saves) {
                  console.log(`    Adding saves line for ${playerName}: ${outcome.point}`);
                  bettingOdds[playerName].saves = {
                    line: outcome.point,
                    odds: outcome.price,
                    bookmaker: bookmaker.title,
                    game: `${event.home_team} vs ${event.away_team}`,
                    gameTime: event.commence_time
                  };
                }
              } else if (market.key === 'player_goal_scorer_anytime' && outcome.name === 'Yes') {
                if (!bettingOdds[playerName].goals) {
                  console.log(`    Adding anytime goal for ${playerName}: ${outcome.price}`);
                  bettingOdds[playerName].goals = {
                    line: 0.5,
                    odds: outcome.price,
                    bookmaker: bookmaker.title,
                    game: `${event.home_team} vs ${event.away_team}`,
                    gameTime: event.commence_time,
                    type: 'anytime_scorer'
                  };
                }
              }
            });
          });
        }

        console.log(`\n=== SUMMARY ===`);
        console.log(`Total outcomes processed: ${totalOutcomes}`);
        console.log(`Unique players processed: ${playersProcessed}`);
        console.log(`Final betting lines count: ${Object.keys(bettingOdds).length}`);
        
        if (Object.keys(bettingOdds).length > 0) {
          console.log('Sample players with odds:', Object.keys(bettingOdds).slice(0, 5));
        }
      } else {
        oddsError = 'ODDS_API_KEY not set';
        console.log('Odds API Key not configured');
      }
    } catch (error) {
      oddsError = error.message;
      console.error('Odds error:', error);
    }

    // Step 4: Save to Vercel Blob
    const cacheData = {
      lastUpdated: new Date().toISOString(),
      season,
      allPlayers: playersWithGames,
      allGoalies: goaliesWithGames,
      gameLogs: gameLogsData,
      goalieGameLogs: goalieGameLogsData,
      bettingOdds,
      stats: {
        totalPlayers: playersWithGames.length,
        totalGoalies: goaliesWithGames.length,
        gameLogsLoaded: successCount,
        goalieLogsLoaded: goalieSuccessCount,
        errors: errorCount + goalieErrorCount,
        bettingLinesLoaded: Object.keys(bettingOdds).length,
        oddsError
      }
    };

    const blob = await put('nhl-cache.json', JSON.stringify(cacheData), {
      access: 'public',
      addRandomSuffix: false
    });

    return res.status(200).json({
      success: true,
      message: 'NHL data updated successfully',
      lastUpdated: cacheData.lastUpdated,
      stats: cacheData.stats,
      blobUrl: blob.url
    });
  } catch (error) {
    console.error('Update error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
