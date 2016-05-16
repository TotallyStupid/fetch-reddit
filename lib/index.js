'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.fetchPosts = fetchPosts;
exports.getPosts = getPosts;
exports.extractPosts = extractPosts;

require('isomorphic-fetch');

var _queryString = require('query-string');

var REDDIT_URL = 'https://www.reddit.com';
var MATCH_REPLY_URLS = /(?:\[+([^\]]+)\]\s*\()?(https?\:\/\/[^\)\s]+)\)?/gi;
var REPLACE_CHAR = String.fromCharCode(0);
var INFER_TITLE_MAX_LENGTH = 128; // Max length of remaining text to use as a title for a link
var MATCH_YOUTUBE_URL = /^(?:https?:\/\/)?(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))((\w|-){11})(?:\S+)?$/;
var THUMBNAIL_PLACEHOLDERS = ['default', 'self', 'nsfw'];

var KIND_COMMENT = 't1';
var KIND_POST = 't3';
var KIND_LISTING = 'Listing';

function get(path, query) {
  path = path[0] === '/' ? path : '/' + path;
  return fetch(REDDIT_URL + path + '.json?' + (0, _queryString.stringify)(query)).then(function (response) {
    return response.json();
  });
}

function fetchPosts(path) {
  var query = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

  return get(path, query).then(function (data) {
    return {
      posts: extractPosts(data, path),
      loadMore: getLoadMoreFn(data, { path: path, query: query })
    };
  });
}

function getPosts(path) {
  var query = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

  console.warn('getPosts is deprecated and will be removed in future versions of fetch-reddit, please use fetchPosts instead');
  return fetchPosts(path, query);
}

function extractPosts(data, path) {
  if (data instanceof Array) {
    return data.reduce(function (posts, post) {
      return posts.concat(extractPosts(post, path));
    }, []);
  }
  if (data.json) {
    return extractPosts(data.json.data.things, path);
  }
  if (data.kind === KIND_LISTING) {
    return extractPosts(data.data.children, path);
  }
  if (data.kind === KIND_POST && !data.data.is_self) {
    return postFromPost(data.data);
  }
  if (data.kind === KIND_COMMENT || data.data.is_self) {
    return extractFromComment(data, path);
  }
  return [];
}

function extractFromComment(post, path) {
  var posts = [];
  if (post.kind === 'more') {
    return posts;
  }
  // Use REPLACE_CHAR to avoid regex problems with escaped ] characters within the title string
  getText(post.data).replace(/\\]/g, REPLACE_CHAR).replace(MATCH_REPLY_URLS, function (match, title, url, offset) {
    if (title) {
      // Bring back the removed ] and then we can safely unescape everything
      title = title.replace(new RegExp(REPLACE_CHAR, 'g'), '\\]').replace(/\\(.)/g, '$1');
    }
    posts.push(postFromComment(post.data, match, title, url, offset, path));
  });
  if (post.data.replies) {
    post.data.replies.data.children.forEach(function (reply) {
      if (reply.kind === KIND_COMMENT) {
        posts = posts.concat(extractFromComment(reply, path));
      }
    });
  }
  return posts;
}

function getLoadMoreFn(data, options) {
  if (data instanceof Array) {
    return getLoadMoreFn(data.pop(), options);
  }
  if (options.parent) {
    return function () {
      return getChildren(options.parent, options.children);
    };
  }
  if (data.kind === 'more') {
    return function () {
      return getChildren(data.data.parent_id, data.data.children);
    };
  }
  if (data.data.after) {
    options.query.after = data.data.after;
    return function () {
      return fetchPosts(options.path, options.query);
    };
  }
  if (data.data.children) {
    return getLoadMoreFn(data.data.children.pop(), options);
  }
}

function getChildren(parent, children) {
  var requestChildren = children.splice(0, 500); // TODO: const
  var query = {
    api_type: 'json',
    link_id: parent,
    children: requestChildren.join(',')
  };
  return get('/api/morechildren', query).then(function (data) {
    return {
      posts: extractPosts(data),
      loadMore: getLoadMoreFn(null, { parent: parent, children: children })
    };
  });
}

function postFromPost(post) {
  return {
    id: post.id,
    title: post.title,
    url: post.url,
    created: new Date(post.created_utc * 1000),
    author: post.author,
    score: post.score,
    subreddit: post.subreddit,
    thumbnail: getThumbnail(post),
    permalink: getPermalink(post),
    // Post-specific fields
    num_comments: post.num_comments
  };
}

function postFromComment(post, match) {
  var title = arguments.length <= 2 || arguments[2] === undefined ? null : arguments[2];
  var url = arguments[3];
  var offset = arguments[4];
  var path = arguments[5];

  // If the post is just a small amount of text and a link, use the text as the title
  var remaining = getText(post).replace(match, '').trim();
  if (!title && remaining.length < INFER_TITLE_MAX_LENGTH && !remaining.match(MATCH_REPLY_URLS)) {
    title = remaining;
  }
  return {
    id: post.id + ':' + offset,
    title: removeMarkdown(title),
    url: url,
    created: new Date(post.created_utc * 1000),
    author: post.author,
    score: post.score,
    subreddit: post.subreddit,
    thumbnail: getThumbnail(post, url),
    permalink: getPermalink(post, path),
    over_18: post.over_18,
    // Comment-specific fields
    comment_id: post.id
  };
}

function getText(post) {
  return post.body || post.selftext || '';
}

function getPermalink(post) {
  var path = arguments.length <= 1 || arguments[1] === undefined ? '' : arguments[1];

  if (post.permalink) {
    return REDDIT_URL + post.permalink;
  }
  var slash = path.slice(-1) === '/' ? '' : '/';
  return REDDIT_URL + path + slash + post.id;
}

function getThumbnail(post) {
  var url = arguments.length <= 1 || arguments[1] === undefined ? post.url : arguments[1];

  if (post.thumbnail && THUMBNAIL_PLACEHOLDERS.indexOf(post.thumbnail) === -1) {
    return post.thumbnail;
  }
  var matchYouTube = url.match(MATCH_YOUTUBE_URL);
  if (matchYouTube) {
    var id = matchYouTube[1];
    return 'http://img.youtube.com/vi/' + id + '/default.jpg';
  }
  return null;
}

// Remove markdown bold/italics
// From https://github.com/stiang/remove-markdown
function removeMarkdown(string) {
  if (!string) return string;
  return string.replace(/([\*_]{1,3})(\S.*?\S)\1/g, '$2');
}