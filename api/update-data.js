// api/update-data.js - Cron job to fetch and cache NHL data + betting odds + dynamic scheduling
import { put } from '@vercel/blob';
import { Client } from '@upstash/qstash';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('Starting daily NHL data update...');
    const startTime = Date.now();
    const season = '20252026';

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
    console.log(`Found ${playersWithGames.length} active players (${Date.now() - startTime}ms)`);

    // Step 2: Fetch ALL goalie stats (paginated)
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
    console.log(`Found ${goaliesWithGames.length} active goalies (${Date.now() - startTime}ms)`);

    // Step 3: Fetch team stats for shot volume rankings
    console.log('Fetching team stats...');
    const teamStatsUrl = `https://api.nhle.com/stats/rest/en/team/summary?cayenneExp=seasonId=${season}`;
    const teamStatsResponse = await fetch(teamStatsUrl);
    const teamStatsData = await teamStatsResponse.json();
    const teamStats = teamStatsData.data || [];

    // Calculate shots per game (offensive) and shots against per game (defensive) and rank teams
    const teamShotData = teamStats.map(team => ({
      abbrev: team.teamCommonName || team.teamFullName,
      teamFullName: team.teamFullName,
      shotsPerGame: (team.shotsForPerGame || 0),
      shotsAgainstPerGame: (team.shotsAgainstPerGame || 0),
      gamesPlayed: team.gamesPlayed || 0
    })).sort((a, b) => b.shotsPerGame - a.shotsPerGame);

    // Add rank (1 = most shots FOR)
    teamShotData.forEach((team, index) => {
      team.rank = index + 1;
    });
    
    // Add defensive rank (1 = allows most shots AGAINST - worst defense)
    const sortedByDefense = [...teamShotData].sort((a, b) => b.shotsAgainstPerGame - a.shotsAgainstPerGame);
    sortedByDefense.forEach((team, index) => {
      const originalTeam = teamShotData.find(t => t.teamFullName === team.teamFullName);
      originalTeam.defensiveRank = index + 1;
    });

    console.log(`Loaded stats for ${teamShotData.length} teams (${Date.now() - startTime}ms)`);

    // Step 4: Fetch betting odds
    console.log('Fetching betting odds...');
    let bettingOdds = {};
    let oddsError = null;
    let nextGameTime = null;

    try {
      const oddsApiKey = process.env.ODDS_API_KEY;
      if (oddsApiKey && oddsApiKey !== 'YOUR_ODDS_API_KEY_HERE') {
        const eventsUrl = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events?apiKey=${oddsApiKey}`;
        const eventsResponse = await fetch(eventsUrl);
        
        if (!eventsResponse.ok) {
          throw new Error(`Events API error ${eventsResponse.status}`);
        }

        const events = await eventsResponse.json();
        
        // Get games in next 48 hours
        const now = new Date();
        const fortyEightHoursFromNow = new Date(now.getTime() + (48 * 60 * 60 * 1000));
        
        const upcomingGames = events.filter(e => {
          const gameTime = new Date(e.commence_time);
          return gameTime >= now && gameTime <= fortyEightHoursFromNow;
        });

        console.log(`Found ${upcomingGames.length} upcoming games`);

        // Find the first game of TODAY
        if (upcomingGames.length > 0) {
          const now = new Date();
          const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const todayEnd = new Date(todayStart.getTime() + (24 * 60 * 60 * 1000));
          
          // Filter for games happening today
          const todaysGames = upcomingGames.filter(e => {
            const gameTime = new Date(e.commence_time);
            return gameTime >= todayStart && gameTime < todayEnd;
          });
          
          if (todaysGames.length > 0) {
            // Sort by time and get the earliest game today
            const sortedTodaysGames = todaysGames.sort((a, b) => 
              new Date(a.commence_time) - new Date(b.commence_time)
            );
            nextGameTime = sortedTodaysGames[0].commence_time;
            console.log(`First game today: ${new Date(nextGameTime).toLocaleString()} (${todaysGames.length} total games today)`);
          } else {
            // No games today, find first game tomorrow or later
            const sortedGames = upcomingGames.sort((a, b) => 
              new Date(a.commence_time) - new Date(b.commence_time)
            );
            nextGameTime = sortedGames[0].commence_time;
            console.log(`No games today. Next game: ${new Date(nextGameTime).toLocaleString()}`);
          }
        }

        // Fetch all props in parallel
        const gamePromises = upcomingGames.map(async event => {
          const eventId = event.id;
          const propsUrl = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events/${eventId}/odds?apiKey=${oddsApiKey}&regions=us&markets=player_points,player_goal_scorer_anytime,player_assists,player_shots_on_goal,player_total_saves&oddsFormat=american`;
          
          try {
            const propsResponse = await fetch(propsUrl);
            if (!propsResponse.ok) return null;
            const data = await propsResponse.json();
            return { event, data };
          } catch (e) {
            return null;
          }
        });

        const allPropsData = await Promise.all(gamePromises);
        
        for (const result of allPropsData) {
          if (!result) continue;
          const { event, data: propsData } = result;

          const bookmaker = propsData.bookmakers?.[0];
          if (!bookmaker) {
            console.log(`[DEBUG] No bookmakers for event ${event.id}`);
            continue;
          }

          console.log(`[DEBUG] Processing event: ${event.home_team} vs ${event.away_team}`);
          console.log(`[DEBUG] Bookmaker: ${bookmaker.title}`);
          console.log(`[DEBUG] Markets available:`, bookmaker.markets?.map(m => m.key));

          bookmaker.markets?.forEach(market => {
            console.log(`[DEBUG] Market: ${market.key}, Outcomes:`, market.outcomes?.length);
            if (market.outcomes && market.outcomes.length > 0) {
              console.log(`[DEBUG] Sample outcome:`, JSON.stringify(market.outcomes[0], null, 2));
            }

            market.outcomes?.forEach(outcome => {
              const playerName = outcome.description;
              if (!playerName) {
                console.log(`[DEBUG] No description in outcome:`, outcome);
                return;
              }
              
              if (!bettingOdds[playerName]) bettingOdds[playerName] = {};

              if (outcome.name === 'Over' && outcome.point !== undefined) {
                if (market.key === 'player_points' && !bettingOdds[playerName].points) {
                  bettingOdds[playerName].points = {
                    line: outcome.point,
                    odds: outcome.price,
                    bookmaker: bookmaker.title,
                    game: `${event.home_team} vs ${event.away_team}`,
                    gameTime: event.commence_time
                  };
                  console.log(`[DEBUG] Added points line for ${playerName}`);
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
                } else if (market.key === 'player_total_saves' && !bettingOdds[playerName].saves) {
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
                  bettingOdds[playerName].goals = {
                    line: 0.5,
                    odds: outcome.price,
                    bookmaker: bookmaker.title,
                    game: `${event.home_team} vs ${event.away_team}`,
                    gameTime: event.commence_time,
                    type: 'anytime_scorer'
                  };
                  console.log(`[DEBUG] Added anytime goal for ${playerName}`);
                }
              }
            });
          });
        }

        console.log(`Loaded betting lines for ${Object.keys(bettingOdds).length} players (${Date.now() - startTime}ms)`);
      } else {
        oddsError = 'ODDS_API_KEY not set';
      }
    } catch (error) {
      oddsError = error.message;
      console.error('Odds error:', error);
    }

    // Step 5: Fetch ALL player game logs
    console.log('Fetching game logs for ALL players...');
    const gameLogsData = {};
    let successCount = 0;
    let errorCount = 0;

    const batchSize = 100;
    for (let i = 0; i < playersWithGames.length; i += batchSize) {
      const batch = playersWithGames.slice(i, i + batchSize);
      
      const results = await Promise.allSettled(
        batch.map(async player => {
          const gameLogUrl = `https://api-web.nhle.com/v1/player/${player.playerId}/game-log/${season}/2`;
          const response = await fetch(gameLogUrl);
          if (response.ok) {
            const gameLog = await response.json();
            if (gameLog?.gameLog?.length > 0) {
              return { playerId: player.playerId, gameLog };
            }
          }
          throw new Error('No data');
        })
      );
      
      results.forEach(result => {
        if (result.status === 'fulfilled') {
          gameLogsData[result.value.playerId] = result.value.gameLog;
          successCount++;
        } else {
          errorCount++;
        }
      });
      
      console.log(`Processed ${Math.min(i + batchSize, playersWithGames.length)}/${playersWithGames.length} players`);
      
      if (i + batchSize < playersWithGames.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    console.log(`Player game logs: ${successCount} success, ${errorCount} errors (${Date.now() - startTime}ms)`);

    // Step 6: Fetch ALL goalie game logs
    console.log('Fetching game logs for ALL goalies...');
    const goalieGameLogsData = {};
    let goalieSuccessCount = 0;
    let goalieErrorCount = 0;

    for (let i = 0; i < goaliesWithGames.length; i += batchSize) {
      const batch = goaliesWithGames.slice(i, i + batchSize);
      
      const goalieResults = await Promise.allSettled(
        batch.map(async goalie => {
          const gameLogUrl = `https://api-web.nhle.com/v1/player/${goalie.playerId}/game-log/${season}/2`;
          const response = await fetch(gameLogUrl);
          if (response.ok) {
            const gameLog = await response.json();
            if (gameLog?.gameLog?.length > 0) {
              return { playerId: goalie.playerId, gameLog };
            }
          }
          throw new Error('No data');
        })
      );
      
      goalieResults.forEach(result => {
        if (result.status === 'fulfilled') {
          goalieGameLogsData[result.value.playerId] = result.value.gameLog;
          goalieSuccessCount++;
        } else {
          goalieErrorCount++;
        }
      });
      
      console.log(`Processed ${Math.min(i + batchSize, goaliesWithGames.length)}/${goaliesWithGames.length} goalies`);
      
      if (i + batchSize < goaliesWithGames.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    console.log(`Goalie game logs: ${goalieSuccessCount} success, ${goalieErrorCount} errors (${Date.now() - startTime}ms)`);

    // Step 7: Schedule dynamic pre-game update with QStash
    if (nextGameTime && process.env.QSTASH_TOKEN) {
      try {
        const qstash = new Client({
          token: process.env.QSTASH_TOKEN,
        });
        
        const gameTime = new Date(nextGameTime);
        const oneHourBefore = new Date(gameTime.getTime() - (60 * 60 * 1000));
        const now = new Date();
        
        // Only schedule if the game is more than 1 hour away
        if (oneHourBefore > now) {
          // Cancel any existing scheduled jobs first (to avoid duplicates)
          try {
            const schedules = await qstash.schedules.list();
            for (const schedule of schedules) {
              if (schedule.destination?.includes('/api/update-data')) {
                await qstash.schedules.delete(schedule.scheduleId);
                console.log(`Cancelled existing schedule: ${schedule.scheduleId}`);
              }
            }
          } catch (e) {
            console.log('No existing schedules to cancel');
          }
          
          // Schedule new update
          const scheduleId = await qstash.schedules.create({
            destination: `https://nhl-player-tracker.vercel.app/api/update-data`,
            cron: `${oneHourBefore.getUTCMinutes()} ${oneHourBefore.getUTCHours()} ${oneHourBefore.getUTCDate()} ${oneHourBefore.getUTCMonth() + 1} *`,
            headers: {
              "Authorization": `Bearer ${process.env.CRON_SECRET}`
            }
          });
          
          console.log(`✅ Scheduled pre-game update for ${oneHourBefore.toLocaleString()} (Schedule ID: ${scheduleId})`);
        } else {
          console.log('Next game is less than 1 hour away, skipping schedule');
        }
      } catch (qstashError) {
        console.error('QStash scheduling error:', qstashError);
        // Don't fail the whole update if scheduling fails
      }
    }

    // Step 8: Save to Vercel Blob
    const cacheData = {
      lastUpdated: new Date().toISOString(),
      nextGameTime,
      season,
      allPlayers: playersWithGames,
      allGoalies: goaliesWithGames,
      gameLogs: gameLogsData,
      goalieGameLogs: goalieGameLogsData,
      teamShotData: teamShotData,
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

    const totalTime = Date.now() - startTime;
    console.log(`Total execution time: ${totalTime}ms`);

    return res.status(200).json({
      success: true,
      message: 'NHL data updated successfully',
      lastUpdated: cacheData.lastUpdated,
      nextGameTime: nextGameTime ? new Date(nextGameTime).toLocaleString() : 'No games found',
      executionTime: `${totalTime}ms`,
      stats: cacheData.stats,
      blobUrl: blob.url
    });
  } catch (error) {
    console.error('Update error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
