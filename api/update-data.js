// api/update-data.js - Optimized cron job to fetch and cache NHL data + betting odds
import { put } from '@vercel/blob';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('Starting daily NHL data update...');
    const startTime = Date.now();
    const season = '20252026';

    // Step 1: Fetch ALL player stats (paginated) - FAST
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
    console.log(`Found ${goaliesWithGames.length} active goalies (${Date.now() - startTime}ms)`);

    // Step 1c: Fetch team stats for shot volume rankings
    console.log('Fetching team stats...');
    const teamStatsUrl = `https://api.nhle.com/stats/rest/en/team/summary?cayenneExp=seasonId=${season}`;
    const teamStatsResponse = await fetch(teamStatsUrl);
    const teamStatsData = await teamStatsResponse.json();
    const teamStats = teamStatsData.data || [];

    // Calculate shots per game and rank teams
    const teamShotData = teamStats.map(team => ({
      abbrev: team.teamCommonName || team.teamFullName,
      teamFullName: team.teamFullName,
      shotsPerGame: (team.shotsForPerGame || 0),
      gamesPlayed: team.gamesPlayed || 0
    })).sort((a, b) => b.shotsPerGame - a.shotsPerGame);

    // Add rank (1 = most shots)
    teamShotData.forEach((team, index) => {
      team.rank = index + 1;
    });

    console.log(`Loaded stats for ${teamShotData.length} teams (${Date.now() - startTime}ms)`);

    // Step 2: Fetch betting odds FIRST (to know which players matter)
    console.log('Fetching betting odds first...');
    let bettingOdds = {};
    let oddsError = null;

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

        // Fetch all props in parallel
        const gamePromises = upcomingGames.map(async event => {
          const eventId = event.id;
          const propsUrl = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events/${eventId}/odds?apiKey=${oddsApiKey}&regions=us&markets=player_points,player_goal_scorer_anytime,player_assists,player_shots_on_goal&oddsFormat=american`;
          
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
          if (!bookmaker) continue;

          bookmaker.markets?.forEach(market => {
            market.outcomes?.forEach(outcome => {
              const playerName = outcome.description;
              if (!playerName) return;
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
                } else if (market.key === 'goalie_saves' && !bettingOdds[playerName].saves) {
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

    // Step 3: Only fetch game logs for TOP players WITH betting lines (ultra fast!)
    console.log('Fetching game logs only for top players with betting lines...');
    const gameLogsData = {};
    let successCount = 0;
    let errorCount = 0;

    // Get player IDs for players with odds
    const playerNamesWithOdds = Object.keys(bettingOdds);
    const playersToFetch = playersWithGames.filter(p => 
      playerNamesWithOdds.includes(p.skaterFullName)
    );

    console.log(`Need logs for ${playersToFetch.length} players with odds`);

    // ONLY fetch top 100 players by points to stay under time limit
    const topPlayers = playersToFetch
      .sort((a, b) => (b.points || 0) - (a.points || 0))
      .slice(0, 100);

    console.log(`Fetching logs for TOP ${topPlayers.length} players only`);

    // Aggressive parallel fetching with timeout protection
    const fetchWithTimeout = async (url, timeoutMs = 3000) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      
      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        return response;
      } catch (error) {
        clearTimeout(timeout);
        throw error;
      }
    };

    const results = await Promise.allSettled(
      topPlayers.map(async player => {
        const gameLogUrl = `https://api-web.nhle.com/v1/player/${player.playerId}/game-log/${season}/2`;
        const response = await fetchWithTimeout(gameLogUrl, 5000); // 5 second timeout per request
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

    console.log(`Game logs: ${successCount} success, ${errorCount} errors (${Date.now() - startTime}ms)`);

    // Step 4: Save to Vercel Blob
    const cacheData = {
      lastUpdated: new Date().toISOString(),
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
      executionTime: `${totalTime}ms`,
      stats: cacheData.stats,
      blobUrl: blob.url
    });
  } catch (error) {
    console.error('Update error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
