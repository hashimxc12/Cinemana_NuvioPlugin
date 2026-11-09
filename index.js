'use strict';

const BASE = 'https://cinemana.shabakaty.cc/api/android/';
const CINEMETA = 'https://v3-cinemeta.strem.io';

let __cinemanaStreamHandler = null;

const builder = {
  defineCatalogHandler() {},
  defineMetaHandler() {},
  defineStreamHandler(handler) {
    __cinemanaStreamHandler = handler;
  }
};

const cache = new Map();

function cached(key, loader, ttl = 120000) {
  const old = cache.get(key);
  if (old && Date.now() - old.time < ttl) return old.value;

  const value = Promise.resolve().then(loader).catch(error => {
    cache.delete(key);
    throw error;
  });

  cache.set(key, { time: Date.now(), value });
  return value;
}

async function request(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
      Referer: 'https://cinemana.shabakaty.cc/',
      Origin: 'https://cinemana.shabakaty.cc',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${url} | BODY: ${body.slice(0, 700)}`
    );
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${body.slice(0, 300)}`);
  }
}

async function api(path) {
  return request(`${BASE}${path}`);
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function titleScore(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);

  if (!x || !y) return 0;
  if (x === y) return 1;

  const xs = new Set(x.split(' '));
  const ys = new Set(y.split(' '));
  let common = 0;

  for (const word of xs) {
    if (ys.has(word)) common++;
  }

  return (2 * common) / (xs.size + ys.size);
}

function getTitles(item) {
  return [
    item?.enTitle,
    item?.arTitle,
    item?.title,
    item?.name,
    item?.englishTitle,
    item?.arabicTitle
  ].filter(Boolean).map(String);
}

function getVideoId(item) {
  const value = item?.nb ?? item?.videoNb ?? item?.id;
  return value == null ? null : String(value);
}

function getYear(value) {
  if (!value) return undefined;
  const match = String(value).match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : undefined;
}

function normalizeType(value) {
  const type = String(value || '').toLowerCase();

  if (/movie|film/.test(type)) return 'movie';
  if (/series|serial|show|tv/.test(type)) return 'series';

  return null;
}

function listFrom(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];

  for (const key of ['data', 'results', 'videos', 'items', 'list']) {
    if (Array.isArray(data[key])) return data[key];
  }

  if (data.data && typeof data.data === 'object') {
    for (const key of ['results', 'videos', 'items', 'list']) {
      if (Array.isArray(data.data[key])) return data.data[key];
    }
  }

  return [];
}

function objectFrom(data) {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data)) return data[0] || null;

  if (data.data && !Array.isArray(data.data) &&
      typeof data.data === 'object') {
    return data.data;
  }

  return data;
}

async function getDetails(id) {
  return cached(`details-${id}`, async () => {
    const data = await api(
      `allVideoInfo/id/${encodeURIComponent(id)}`
    );
    return objectFrom(data);
  });
}

async function getStreams(videoId) {
  return cached(`player-${videoId}`, async () => {
    const data = await api(
      `transcoddedFiles/id/${encodeURIComponent(videoId)}`
    );
    return listFrom(data);
  }, 30000);
}

async function getSeriesEpisodes(rootId) {
  return cached(`seasons-${rootId}`, async () => {
    const data = await api(
      `videoSeason/id/${encodeURIComponent(rootId)}`
    );
    return listFrom(data);
  });
}

async function getExternalMeta(type, id) {
  return cached(`external-${type}-${id}`, async () => {
    const data = await request(
      `${CINEMETA}/meta/${type}/${encodeURIComponent(id)}.json`
    );

    if (!data.meta?.name) {
      throw new Error(`No external metadata for ${id}`);
    }

    return data.meta;
  }, 600000);
}

async function searchCinemana(title, type, year) {
  return cached(
    `search-${type}-${normalizeTitle(title)}-${year || ''}`,
    async () => {
      const queries = [...new Set([
        title,
        ...(year ? [`${title} ${year}`] : [])
      ])];

      const foundItems = new Map();

      for (const term of queries) {
        const params = new URLSearchParams({
          videoTitle: term,
          page: '1'
        });

        const data = await api(`AdvancedSearch?${params.toString()}`);

        for (const item of listFrom(data)) {
          const id = getVideoId(item);
          if (id) foundItems.set(id, item);
        }
      }

      const queryTitle = normalizeTitle(title);

      const ranked = [...foundItems.values()].map(item => {
        const titles = getTitles(item);
        let score = Math.max(
          0,
          ...titles.map(candidate => titleScore(title, candidate))
        );

        const itemYear = getYear(
          item.year || item.releaseYear || item.releaseDate
        );

        if (year && itemYear) {
          if (year === itemYear) score += 0.08;
          else score -= 0.12;
        }

        const itemType = normalizeType(item.kind || item.type);

        if (itemType && itemType !== type) score -= 0.5;

        if (
          queryTitle.split(' ').length === 1 &&
          titles.some(candidate =>
            normalizeTitle(candidate).split(' ').length > 1
          ) &&
          !titles.some(candidate =>
            normalizeTitle(candidate) === queryTitle
          )
        ) {
          score = 0;
        }

        return { item, score };
      }).sort((a, b) => b.score - a.score);

      const best = ranked[0];

      if (best && best.score >= 0.72) {
        console.log(
          '[CINEMANA MATCH]',
          title,
          '=>',
          getTitles(best.item).join(' / '),
          'ID:',
          getVideoId(best.item),
          'score:',
          best.score.toFixed(2)
        );

        return best.item;
      }

      console.log(
        '[CINEMANA NOT FOUND]',
        title,
        year,
        type,
        ranked.slice(0, 3).map(item => ({
          titles: getTitles(item.item),
          score: item.score.toFixed(2)
        }))
      );

      return null;
    },
    600000
  );
}

function parseExternalId(id) {
  const match = String(id).match(/^(tt\d+)(?::(\d+):(\d+))?$/);

  if (!match) return null;

  return {
    imdbId: match[1],
    season: match[2] ? Number(match[2]) : null,
    episode: match[3] ? Number(match[3]) : null
  };
}

function numberOf(value) {
  const match = String(value ?? '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

async function findEpisode(details, showId, seasonNumber, episodeNumber) {
  const rootId = String(
    details?.rootSeries ||
    details?.rootSeriesId ||
    details?.nb ||
    showId
  );

  const episodes = await getSeriesEpisodes(rootId);

  const matches = episodes.filter(item => {
    const season = numberOf(item.season ?? item.seasonNumber);
    const episode = numberOf(
      item.episodeNummer ??
      item.episodeNumber ??
      item.episode
    );

    return season === seasonNumber && episode === episodeNumber;
  });

  if (matches.length !== 1) {
    console.log(
      '[CINEMANA EPISODE MATCH]',
      'root:', rootId,
      'season:', seasonNumber,
      'episode:', episodeNumber,
      'matches:', matches.length
    );
    return null;
  }

  return getVideoId(matches[0]);
}

function absoluteUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';

  if (/^https?:\/\//i.test(url)) return url;

  if (url.startsWith('//')) return `https:${url}`;

  return new URL(url, 'https://cinemana.shabakaty.cc/').toString();
}

function videoQuality(video) {
  return String(
    video.resolution ||
    video.name ||
    video.container ||
    'Video'
  );
}

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    let videoId = null;

    const external = parseExternalId(id);

    if (!external) {
      console.log('[UNSUPPORTED ID]', type, id);
      return { streams: [] };
    }

    const meta = await getExternalMeta(type, external.imdbId);
    const year = getYear(meta.year);

    const found = await searchCinemana(meta.name, type, year);

    if (!found) return { streams: [] };

    const foundId = getVideoId(found);
    if (!foundId) return { streams: [] };

    const details = await getDetails(foundId);
    if (!details) return { streams: [] };

    if (type === 'movie') {
      videoId = getVideoId(details) || foundId;
    } else {
      if (!external.season || !external.episode) {
        return { streams: [] };
      }

      videoId = await findEpisode(
        details,
        foundId,
        external.season,
        external.episode
      );
    }

    if (!videoId) {
      console.log('[NO CINEMANA VIDEO ID]', type, id);
      return { streams: [] };
    }

    const files = await getStreams(videoId);

    const streams = files
      .map(video => {
        const url = absoluteUrl(
          video.videoUrl ||
          video.url
        );

        if (!url || !/^https?:\/\//i.test(url)) return null;

        const quality = videoQuality(video);

        return {
          name: `Cinemana · ${quality}`,
          title: `${quality} • Cinemana`,
          url
        };
      })
      .filter(Boolean);

    console.log(
      '[CINEMANA STREAMS]',
      type,
      id,
      'video:',
      videoId,
      'count:',
      streams.length
    );

    return { streams };
  } catch (error) {
    console.error('[CINEMANA STREAM ERROR]', type, id, error.message);
    return { streams: [] };
  }
});

async function resolveNuvioImdbId(id, mediaType) {
  const value = String(id || '').replace(/^imdb:/i, '');

  if (/^tt\d+$/i.test(value)) return value;

  const key = typeof TMDB_API_KEY !== 'undefined' ? TMDB_API_KEY : '';

  if (!key) throw new Error('TMDB_API_KEY is missing');

  const kind = String(mediaType).toLowerCase() === 'tv' ||
    String(mediaType).toLowerCase() === 'series'
    ? 'tv'
    : 'movie';

  const data = await request(
    'https://api.themoviedb.org/3/' + kind + '/' +
    encodeURIComponent(value) +
    '/external_ids?api_key=' + encodeURIComponent(key)
  );

  return data && data.imdb_id ? data.imdb_id : null;
}

async function getStreamsForNuvio(input, mediaType, season, episode) {
  try {
    const args = input && typeof input === 'object'
      ? input
      : { tmdbId: input, mediaType, season, episode };

    const rawType = String(args.mediaType || 'movie').toLowerCase();
    const oldType = rawType === 'tv' ? 'series' : rawType;

    const imdbId = await resolveNuvioImdbId(
      args.tmdbId,
      rawType
    );

    if (!imdbId || !__cinemanaStreamHandler) return [];

    let id = imdbId;

    if (oldType === 'series') {
      if (args.season == null || args.episode == null) return [];

      id += ':' + Number(args.season) + ':' + Number(args.episode);
    }

    const result = await __cinemanaStreamHandler({
      type: oldType,
      id
    });

    return Array.isArray(result && result.streams)
      ? result.streams
      : [];
  } catch (error) {
    console.error('[Cinemana Nuvio Bridge]', error);
    return [];
  }
}

module.exports = {
  getStreams: getStreamsForNuvio
};
