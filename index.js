'use strict';

const BASE = 'https://cinemana.shabakaty.cc/api/android/';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const HEALTH = 'https://cinemana.shabakaty.cc/api/android/healthCheck';
const CONTROL = 'https://api.github.com/zen';

let __cinemanaStreamHandler = null;

const builder = {
  defineCatalogHandler() {},
  defineMetaHandler() {},
  defineStreamHandler(handler) {
    __cinemanaStreamHandler = handler;
  }
};

const cache = new Map();

function cached(key, loader, ttl) {
  if (ttl == null) ttl = 120000;
  const old = cache.get(key);
  if (old && Date.now() - old.time < ttl) return old.value;

  const value = Promise.resolve().then(loader).catch(function (error) {
    cache.delete(key);
    throw error;
  });

  cache.set(key, { time: Date.now(), value: value });
  return value;
}

function probe(url, timeoutMs) {
  if (timeoutMs == null) timeoutMs = 6000;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);

  return fetch(url, {
    method: 'GET',
    signal: controller.signal,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'
    }
  })
  .then(function (res) { clearTimeout(timer); return res.ok; })
  .catch(function () { clearTimeout(timer); return false; });
}

function diagnoseNetwork() {
  return cached('diagnostic', function () {
    return probe(HEALTH).then(function (cinemanaOk) {
      if (cinemanaOk) {
        console.log('CINEMANA_HOST_REACHABLE');
        return 'CINEMANA_HOST_REACHABLE';
      }
      return probe(CONTROL).then(function (internetOk) {
        if (internetOk) {
          console.log('CINEMANA_HOST_UNREACHABLE_INTERNET_OK');
          return 'CINEMANA_HOST_UNREACHABLE_INTERNET_OK';
        }
        console.log('NETWORK_CONNECTIVITY_UNCLEAR');
        return 'NETWORK_CONNECTIVITY_UNCLEAR';
      });
    });
  }, 30000);
}

function request(url) {
  return fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
      Referer: 'https://cinemana.shabakaty.cc/',
      Origin: 'https://cinemana.shabakaty.cc',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  })
  .then(function (response) {
    return response.text().then(function (body) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + url + ' | BODY: ' + body.slice(0, 700));
      }
      try {
        return JSON.parse(body);
      } catch (e) {
        throw new Error('Invalid JSON from ' + url + ': ' + body.slice(0, 300));
      }
    });
  });
}

function api(path) {
  return request(BASE + path).catch(function (error) {
    if (/fetch failed|NetworkError|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|abort/i.test(error.message)) {
      return diagnoseNetwork().then(function () { throw error; });
    }
    throw error;
  });
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
  xs.forEach(function (word) { if (ys.has(word)) common++; });
  return (2 * common) / (xs.size + ys.size);
}

function getTitles(item) {
  return [item && item.enTitle, item && item.arTitle, item && item.title, item && item.name, item && item.englishTitle, item && item.arabicTitle]
    .filter(Boolean).map(String);
}

function getVideoId(item) {
  if (!item) return null;
  let value = null;
  if (item.nb != null) value = item.nb;
  else if (item.videoNb != null) value = item.videoNb;
  else if (item.id != null) value = item.id;
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
  const keys = ['data', 'results', 'videos', 'items', 'list'];
  for (let i = 0; i < keys.length; i++) {
    if (Array.isArray(data[keys[i]])) return data[keys[i]];
  }
  if (data.data && typeof data.data === 'object') {
    for (let i = 0; i < keys.length; i++) {
      if (Array.isArray(data.data[keys[i]])) return data.data[keys[i]];
    }
  }
  return [];
}

function objectFrom(data) {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data)) return data[0] || null;
  if (data.data && !Array.isArray(data.data) && typeof data.data === 'object') return data.data;
  return data;
}

function getDetails(id) {
  return cached('details-' + id, function () {
    return api('allVideoInfo/id/' + encodeURIComponent(id)).then(objectFrom);
  });
}

function getStreams(videoId) {
  return cached('player-' + videoId, function () {
    // الحل الاحتياطي: يجرب المسار الأول، وإن فشل يجرب المسار الثاني
    return api('transcodedFiles/id/' + encodeURIComponent(videoId))
      .then(listFrom)
      .catch(function (error) {
        console.log('[CINEMANA PATH FALLBACK] trying transcoddedFiles');
        return api('transcoddedFiles/id/' + encodeURIComponent(videoId)).then(listFrom);
      });
  }, 30000);
}

function getSeriesEpisodes(rootId) {
  return cached('seasons-' + rootId, function () {
    return api('videoSeason/id/' + encodeURIComponent(rootId)).then(listFrom);
  });
}

function getExternalMeta(type, id) {
  return cached('external-' + type + '-' + id, function () {
    return request(CINEMETA + '/meta/' + type + '/' + encodeURIComponent(id) + '.json').then(function (data) {
      if (!data.meta || !data.meta.name) throw new Error('No external metadata for ' + id);
      return data.meta;
    });
  }, 600000);
}

function searchCinemana(title, type, year) {
  return cached('search-' + type + '-' + normalizeTitle(title) + '-' + (year || ''), function () {
    const queries = [title];
    if (year) queries.push(title + ' ' + year);
    const foundItems = new Map();

    function fetchAll(index) {
      if (index >= queries.length) return Promise.resolve(foundItems);
      const term = queries[index];
      const params = new URLSearchParams({ videoTitle: term, page: '1' });
      return api('AdvancedSearch?' + params.toString()).then(function (data) {
        const items = listFrom(data);
        for (let i = 0; i < items.length; i++) {
          const id = getVideoId(items[i]);
          if (id) foundItems.set(id, items[i]);
        }
        return fetchAll(index + 1);
      });
    }

    return fetchAll(0).then(function (items) {
      const queryTitle = normalizeTitle(title);
      const ranked = [];
      items.forEach(function (item) {
        const titles = getTitles(item);
        let score = 0;
        for (let i = 0; i < titles.length; i++) {
          const s = titleScore(title, titles[i]);
          if (s > score) score = s;
        }
        const itemYear = getYear(item.year || item.releaseYear || item.releaseDate);
        if (year && itemYear) {
          if (year === itemYear) score += 0.08;
          else score -= 0.12;
        }
        const itemType = normalizeType(item.kind || item.type);
        if (itemType && itemType !== type) score -= 0.5;
        const singleWord = queryTitle.split(' ').length === 1;
        let hasMultiWord = false;
        let hasExact = false;
        for (let i = 0; i < titles.length; i++) {
          const n = normalizeTitle(titles[i]);
          if (n.split(' ').length > 1) hasMultiWord = true;
          if (n === queryTitle) hasExact = true;
        }
        if (singleWord && hasMultiWord && !hasExact) score = 0;
        ranked.push({ item: item, score: score });
      });
      ranked.sort(function (a, b) { return b.score - a.score; });

      const best = ranked[0];
      if (best && best.score >= 0.72) {
        console.log('[CINEMANA MATCH]', title, '=>', getTitles(best.item).join(' / '), 'ID:', getVideoId(best.item), 'score:', best.score.toFixed(2));
        return best.item;
      }
      const top3 = ranked.slice(0, 3).map(function (i) { return { titles: getTitles(i.item), score: i.score.toFixed(2) }; });
      console.log('[CINEMANA NOT FOUND]', title, year, type, top3);
      return null;
    });
  }, 600000);
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
  const match = String(value == null ? '' : value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function findEpisode(details, showId, seasonNumber, episodeNumber) {
  const rootId = String((details && (details.rootSeries || details.rootSeriesId || details.nb)) || showId);
  return getSeriesEpisodes(rootId).then(function (episodes) {
    const matches = episodes.filter(function (item) {
      const season = numberOf(item.season != null ? item.season : item.seasonNumber);
      const episode = numberOf(item.episodeNummer != null ? item.episodeNummer : (item.episodeNumber != null ? item.episodeNumber : item.episode));
      return season === seasonNumber && episode === episodeNumber;
    });
    if (matches.length !== 1) {
      console.log('[CINEMANA EPISODE MATCH]', 'root:', rootId, 'season:', seasonNumber, 'episode:', episodeNumber, 'matches:', matches.length);
      return null;
    }
    return getVideoId(matches[0]);
  });
}

function absoluteUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return 'https:' + url;
  return new URL(url, 'https://cinemana.shabakaty.cc/').toString();
}

function videoQuality(video) {
  return String(video.resolution || video.name || video.container || 'Video');
}

function fetchStreams(type, id) {
  let videoId = null;

  const external = parseExternalId(id);
  if (!external) {
    console.log('[UNSUPPORTED ID]', type, id);
    return Promise.resolve({ streams: [] });
  }

  return getExternalMeta(type, external.imdbId).then(function (meta) {
    const year = getYear(meta.year);
    return searchCinemana(meta.name, type, year);
  })
  .then(function (found) {
    if (!found) return null;
    const foundId = getVideoId(found);
    if (!foundId) return null;
    return getDetails(foundId).then(function (details) {
      if (!details) return null;
      if (type === 'movie') {
        videoId = getVideoId(details) || foundId;
        return videoId;
      }
      if (!external.season || !external.episode) return null;
      return findEpisode(details, foundId, external.season, external.episode);
    });
  })
  .then(function (resolvedId) {
    videoId = resolvedId;
    if (!videoId) {
      console.log('[NO CINEMANA VIDEO ID]', type, id);
      return { streams: [] };
    }
    return getStreams(videoId).then(function (files) {
      const streams = [];
      for (let i = 0; i < files.length; i++) {
        const video = files[i];
        const url = absoluteUrl(video.videoUrl || video.url);
        if (!url || !/^https?:\/\//i.test(url)) continue;
        const quality = videoQuality(video);
        streams.push({ name: 'Cinemana · ' + quality, title: quality + ' • Cinemana', url: url });
      }
      console.log('[CINEMANA STREAMS]', type, id, 'video:', videoId, 'count:', streams.length);
      return { streams: streams };
    });
  })
  .catch(function (error) {
    console.error('[CINEMANA STREAM ERROR]', type, id, error.message);
    return { streams: [] };
  });
}

builder.defineStreamHandler(function (input) {
  return fetchStreams(input.type, input.id);
});

function resolveNuvioImdbId(id, mediaType) {
  const value = String(id || '').replace(/^imdb:/i, '');
  if (/^tt\d+$/i.test(value)) return Promise.resolve(value);

  const key = typeof TMDB_API_KEY !== 'undefined' ? TMDB_API_KEY : '';
  if (!key) return Promise.reject(new Error('TMDB_API_KEY is missing'));

  const kind = ['tv', 'series'].indexOf(String(mediaType).toLowerCase()) >= 0 ? 'tv' : 'movie';
  return request('https://api.themoviedb.org/3/' + kind + '/' + encodeURIComponent(value) + '/external_ids?api_key=' + encodeURIComponent(key))
    .then(function (data) { return data && data.imdb_id ? data.imdb_id : null; });
}

function getStreamsForNuvio(input, mediaType, season, episode) {
  return Promise.resolve().then(function () {
    const args = input && typeof input === 'object'
      ? input
      : { tmdbId: input, mediaType: mediaType, season: season, episode: episode };

    const rawType = String(args.mediaType || 'movie').toLowerCase();
    const oldType = rawType === 'tv' ? 'series' : rawType;

    return resolveNuvioImdbId(args.tmdbId, rawType).then(function (imdbId) {
      if (!imdbId) return [];

      let id = imdbId;
      if (oldType === 'series') {
        if (args.season == null || args.episode == null) return [];
        id += ':' + Number(args.season) + ':' + Number(args.episode);
      }

      return fetchStreams(oldType, id).then(function (result) {
        return Array.isArray(result && result.streams) ? result.streams : [];
      });
    });
  }).catch(function (error) {
    console.error('[Cinemana Nuvio Bridge]', error);
    return [];
  });
}

module.exports = { getStreams: getStreamsForNuvio };
