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

    const batchSize = 50;
    for (let i = 0; i < playersWithGames.length; i += batchSize) {
      const batch = playersWithGames.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(playersWithGames.length / batchSize);

      console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} players)...`);

      await Promise.all(
        batch.map(async player => {
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
        })
      );

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
          events.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));

          const today = new Date();
          const todayStr = today.toISOString().split('T')[0];

          const todaysGames = events.filter(event => {
            const gameDate = new Date(event.commence_time).toISOString().split('T')[0];
            return gameDate === todayStr;
          });

          console.log(`Fetching player props for ALL ${todaysGames.length} games today...`);

          const gamePromises = todaysGames.map(async event => {
            try {
              const eventId = event.id;
              const gameDate = new Date(event.commence_time).toLocaleString();
              const propsUrl = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events/${eventId}/odds?apiKey=${oddsApiKey}&regions=us&markets=player_points,player_goals,player_goal_scorer,player_to_score,player_assists,player_shots_on_goal&oddsFormat=american`;

              console.log(`Fetching: ${event.home_team} vs ${event.away_team} (${gameDate})`);

              const propsResponse = await fetch(propsUrl);

              if (!propsResponse.ok) {
                console.log(`Failed for event ${eventId}: ${propsResponse.status}`);
                return null;
              }

              return await propsResponse.json();
            } catch (error) {
              console.error(`Error fetching event ${event.id}:`, error.message);
              return null;
            }
          });

          const allPropsData = await Promise.all(gamePromises);

          for (let i = 0; i < todaysGames.length; i++) {
            const event = todaysGames[i];
            const propsData = allPropsData[i];
            if (!propsData) continue;

            // ✅ UPDATED SECTION — loops through all bookmakers and flexible parsing
            for (const bookmaker of propsData.bookmakers || []) {
              console.log(`Processing odds from ${bookmaker.title}`);

              bookmaker.markets?.forEach(market => {
                const key = market.key.toLowerCase();

                market.outcomes?.forEach(outcome => {
                  const playerName = outcome.description?.trim();
                  if (!playerName) return;

                  if (!bettingOdds[playerName]) bettingOdds[playerName] = {};

                  const outcomeName = outcome.name?.toLowerCase();
                  const validGoalKeys = [
                    'player_goals',
                    'player_goal_scorer',
                    'player_to_score',
                    'player_anytime_goalscorer'
                  ];

                  const addLine = (statKey, lineData) => {
                    if (!bettingOdds[playerName][statKey]) {
                      bettingOdds[playerName][statKey] = lineData;
                    }
                  };

                  // Points
                  if (key === 'player_points' && outcome.point !== undefined && outcomeName === 'over') {
                    addLine('points', {
                      line: outcome.point,
                      odds: outcome.price,
                      bookmaker: bookmaker.title,
                      game: `${event.home_team} vs ${event.away_team}`,
                      gameTime: event.commence_time
                    });
                  }

                  // Goals – handle all naming and outcome variants
                  else if (validGoalKeys.includes(key) && ['over', 'yes', 'to score', 'will score'].includes(outcomeName)) {
                    addLine('goals', {
                      line: outcome.point ?? 1,
                      odds: outcome.price,
                      bookmaker: bookmaker.title,
                      game: `${event.home_team} vs ${event.away_team}`,
                      gameTime: event.commence_time
                    });
                  }

                  // Assists
                  else if (key === 'player_assists' && outcome.point !== undefined && outcomeName === 'over') {
                    addLine('assists', {
                      line: outcome.point,
                      odds: outcome.price,
                      bookmaker: bookmaker.title,
                      game: `${event.home_team} vs ${event.away_team}`,
                      gameTime: event.commence_time
                    });
                  }

                  // Shots
                  else if (key === 'player_shots_on_goal' && outcome.point !== undefined && outcomeName === 'over') {
                    addLine('shots', {
                      line: outcome.point,
                      odds: outcome.price,
                      bookmaker: bookmaker.title,
                      game: `${event.home_team} vs ${event.away_team}`,
                      gameTime: event.commence_time
                    });
                  }
                });
              });
            }

            await new Promise(resolve => setTimeout(resolve, 100));
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

    // Step 4: Save everything to Vercel Blob storage
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

    const blob = await put('nhl-cache.json', JSON.stringify(cacheData), {
      access: 'public',
      addRandomSuffix: false
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
