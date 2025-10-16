// api/update-data.js - Cron job to fetch and cache NHL data + betting odds daily
import { put } from '@vercel/blob';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
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

    // Step 2: Fetch game logs
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

    // Step 3: Fetch betting odds
    console.log('Fetching betting odds from The Odds API...');
    let bettingOdds = {};
    let oddsError = null;

    try {
      const oddsApiKey = process.env.ODDS_API_KEY;
      if (oddsApiKey && oddsApiKey !== 'YOUR_ODDS_API_KEY_HERE') {
        const eventsUrl = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events?apiKey=${oddsApiKey}`;
        const eventsResponse = await fetch(eventsUrl);
        if (!eventsResponse.ok) throw new Error(`Events API error ${eventsResponse.status}`);

        const events = await eventsResponse.json();
        const today = new Date().toISOString().split('T')[0];
        const todaysGames = events.filter(e => new Date(e.commence_time).toISOString().split('T')[0] === today);

        console.log(`Fetching props for ${todaysGames.length} games today`);

        const gamePromises = todaysGames.map(async event => {
          const eventId = event.id;
          const propsUrl = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events/${eventId}/odds?apiKey=${oddsApiKey}&regions=us&markets=player_points,player_goal_scorer_anytime,player_assists,player_shots_on_goal&oddsFormat=american`;
          const propsResponse = await fetch(propsUrl);
          if (!propsResponse.ok) return null;
          return { event, data: await propsResponse.json() };
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
                }
              } else if (market.key === 'player_goal_scorer_anytime' && outcome.name === 'Yes') {
                // Store anytime goal scorer as goals with 0.5 line
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

        console.log(`Loaded betting lines for ${Object.keys(bettingOdds).length} players`);
      } else {
        oddsError = 'ODDS_API_KEY not set';
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
      gameLogs: gameLogsData,
      bettingOdds,
      stats: {
        totalPlayers: playersWithGames.length,
        gameLogsLoaded: successCount,
        errors: errorCount,
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
