/** 手工构造的 X GraphQL 响应片段 (非真实抓包, 结构参考公开资料) */
export interface TweetOpts {
  id: string
  text?: string
  screen_name?: string
  name?: string
  user_id?: string
  created_at?: string
  urls?: { url: string; expanded_url: string }[]
  photos?: string[]
  video?: { thumb: string; variants: { bitrate?: number; content_type: string; url: string }[] }
  quoted?: any
  note?: string
  views?: string
  likes?: number
  newUserShape?: boolean
  conversation_id?: string
  lang?: string
}

export function tweet(o: TweetOpts) {
  const screen_name = o.screen_name ?? 'alice'
  const media: any[] = []
  for (const [i, u] of (o.photos ?? []).entries()) {
    media.push({ type: 'photo', media_url_https: u, url: `https://t.co/pic${o.id}${i}`, original_info: { width: 800, height: 600 }, ext_alt_text: i === 0 ? 'alt text' : undefined })
  }
  if (o.video) {
    media.push({
      type: 'video',
      media_url_https: o.video.thumb,
      url: `https://t.co/vid${o.id}`,
      video_info: { duration_millis: 12000, variants: o.video.variants },
    })
  }
  const mediaLinks = media.map((m) => ' ' + m.url).join('')
  const legacyUser = { screen_name, name: o.name ?? 'Alice', profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/a.jpg' }
  const userResult = o.newUserShape
    ? { __typename: 'User', rest_id: o.user_id ?? '111', core: { screen_name, name: o.name ?? 'Alice' }, avatar: { image_url: 'https://pbs.twimg.com/profile_images/1/new.jpg' }, legacy: {} }
    : { __typename: 'User', rest_id: o.user_id ?? '111', legacy: legacyUser }
  return {
    __typename: 'Tweet',
    rest_id: o.id,
    core: { user_results: { result: userResult } },
    views: { count: o.views ?? '1234', state: 'EnabledWithCount' },
    ...(o.note ? { note_tweet: { note_tweet_results: { result: { text: o.note, entity_set: { urls: o.urls ?? [] } } } } } : {}),
    quoted_status_result: o.quoted ? { result: o.quoted } : undefined,
    legacy: {
      id_str: o.id,
      created_at: o.created_at ?? 'Wed Oct 10 20:19:24 +0000 2018',
      full_text: (o.text ?? 'hello world') + (o.urls ?? []).map((u) => ' ' + u.url).join('') + mediaLinks,
      lang: o.lang ?? 'en',
      user_id_str: o.user_id ?? '111',
      conversation_id_str: o.conversation_id ?? o.id,
      is_quote_status: !!o.quoted,
      reply_count: 1,
      retweet_count: 2,
      favorite_count: o.likes ?? 3,
      quote_count: 4,
      bookmark_count: 5,
      entities: { urls: o.urls ?? [], media },
      extended_entities: media.length ? { media } : undefined,
    },
  }
}

export function tweetEntry(t: any, sortIndex: string, wrap = false) {
  return {
    entryId: `tweet-${t.rest_id}`,
    sortIndex,
    content: {
      entryType: 'TimelineTimelineItem',
      __typename: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineTweet',
        __typename: 'TimelineTweet',
        tweet_results: { result: wrap ? { __typename: 'TweetWithVisibilityResults', tweet: t } : t },
      },
    },
  }
}

export function cursorEntry(value: string, type: 'Bottom' | 'Top' = 'Bottom') {
  return {
    entryId: `cursor-${type.toLowerCase()}-${value}`,
    sortIndex: '0',
    content: { entryType: 'TimelineTimelineCursor', __typename: 'TimelineTimelineCursor', value, cursorType: type },
  }
}

export function bookmarksPage(entries: any[]) {
  return {
    data: {
      bookmark_timeline_v2: {
        timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] },
      },
    },
  }
}

export function folderTimelinePage(entries: any[]) {
  return { data: { bookmark_collection_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } }
}

export function foldersResponse(folders: { id: string; name: string }[]) {
  return { data: { viewer: { user_results: { result: { bookmark_collections_slice: { items: folders, slice_info: {} } } } } } }
}

/** 生成 n 条书签, id 从大到小 (越新的书签 sortIndex 越大) */
export function makeTweets(ids: string[], extra: Partial<TweetOpts> = {}) {
  return ids.map((id) => tweet({ id, text: `post ${id}`, ...extra }))
}

export function threadResponse(focal: any, others: { tweet: any; module?: boolean }[]) {
  const entries: any[] = [tweetEntry(focal, '100')]
  for (const o of others) {
    if (o.module) {
      entries.push({
        entryId: `conversationthread-${o.tweet.rest_id}`,
        sortIndex: '50',
        content: {
          entryType: 'TimelineTimelineModule',
          items: [{ entryId: `conversationthread-1-tweet-${o.tweet.rest_id}`, item: { itemContent: { itemType: 'TimelineTweet', tweetDisplayType: 'SelfThread', tweet_results: { result: o.tweet } } } }],
        },
      })
    } else entries.push(tweetEntry(o.tweet, '90'))
  }
  return { data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries', entries }] } } }
}

export function userTweetsPage(entries: any[]) {
  return {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] },
          },
        },
      },
    },
  }
}

export function userByScreenNameResponse(id: string, screen: string) {
  return { data: { user: { result: { rest_id: id, legacy: { screen_name: screen } } } } }
}
