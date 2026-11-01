import type { Post } from '@/shared/types'
import { bookmarkOutlineClass, libraryAuthorDecor, marksForPost } from '@/strike/lib/author-flags.js'
import type { AuthorFlagName } from '../author-flags'
import { useT } from '../i18n'

export type TagEffectChoice = { Spam?: string; Marketing?: string }

export interface AuthorMarkLookup {
  byUserId: { get(id: string): unknown }
  byHandle: { get(handle: string): unknown }
}

type Marks = {
  marketing?: boolean
  spam?: boolean
  explicit?: { marketing?: boolean; spam?: boolean }
  fromStrike?: { marketing?: boolean; spam?: boolean }
}

function readMarks(post: Post, lookup?: AuthorMarkLookup | null): Marks {
  return (marksForPost(post, lookup) ?? {}) as Marks
}

export function authorOutlineClass(post: Post, lookup?: AuthorMarkLookup | null, effects?: TagEffectChoice) {
  return String(bookmarkOutlineClass(readMarks(post, lookup), { tagEffects: effects || {} }) || '')
}

function chipClass(effect: string, kind: 'spam' | 'marketing') {
  if (effect === 'none') return 'badge author-plain'
  return kind === 'spam' ? 'badge author-spam' : 'badge author-marketing'
}

export function AuthorMarkChips({
  post,
  lookup,
  effects,
}: {
  post: Post
  lookup?: AuthorMarkLookup | null
  effects?: TagEffectChoice
}) {
  const t = useT()
  const marks = readMarks(post, lookup)
  if (!marks.marketing && !marks.spam) return null
  const decor = libraryAuthorDecor(marks, { tagEffects: effects || {} }) as {
    spamEffect?: string
    marketingEffect?: string
  }
  const titleFor = (kind: AuthorFlagName) => {
    const explicit = !!marks.explicit?.[kind]
    const fromStrike = !!marks.fromStrike?.[kind]
    if (explicit && fromStrike) return t(kind === 'marketing' ? 'author_flag_both_m' : 'author_flag_both_s')
    if (explicit) return t(kind === 'marketing' ? 'author_flag_explicit_m' : 'author_flag_explicit_s')
    return t(kind === 'marketing' ? 'author_flag_strike_m' : 'author_flag_strike_s')
  }
  return (
    <span className="author-marks">
      {marks.marketing && (
        <span className={chipClass(decor.marketingEffect || 'chip', 'marketing')} title={titleFor('marketing')}>
          {t('chip_marketing')}
        </span>
      )}
      {marks.spam && (
        <span className={chipClass(decor.spamEffect || 'chip', 'spam')} title={titleFor('spam')}>
          {t('chip_spam')}
        </span>
      )}
    </span>
  )
}

export function AuthorMarkButtons({
  post,
  lookup,
  onToggle,
}: {
  post: Post
  lookup?: AuthorMarkLookup | null
  onToggle: (post: Post, flag: AuthorFlagName, value: boolean) => void
}) {
  const t = useT()
  const marks = readMarks(post, lookup)
  const marketingOn = !!marks.explicit?.marketing
  const spamOn = !!marks.explicit?.spam
  return (
    <span className="author-flag-actions">
      <button
        type="button"
        className={marketingOn ? 'author-flag-btn on' : 'author-flag-btn'}
        onClick={() => onToggle(post, 'marketing', !marketingOn)}
      >
        {marketingOn ? t('unmark_marketing') : t('mark_marketing')}
      </button>
      <button
        type="button"
        className={spamOn ? 'author-flag-btn on spam' : 'author-flag-btn'}
        onClick={() => onToggle(post, 'spam', !spamOn)}
      >
        {spamOn ? t('unmark_spam') : t('mark_spam')}
      </button>
    </span>
  )
}
