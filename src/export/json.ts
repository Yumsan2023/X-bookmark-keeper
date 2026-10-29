import type { Post } from '@/shared/types'

export function postsToJson(posts: Post[]): string {
  return JSON.stringify(posts, null, 2)
}
