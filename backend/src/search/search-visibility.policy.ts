import { SelectQueryBuilder } from 'typeorm';
import { ArtistStatus } from '../artists/entities/artist.entity';

/**
 * Centralised visibility predicates for public search and suggestions.
 *
 * Apply these helpers to every query that surfaces content to unauthenticated
 * or non-owner users.  Keeping the rules in one place means a single change
 * propagates to all search surfaces (full-text search, suggestions, browse).
 *
 * Rules enforced by this policy:
 *   Artists:
 *     - `deletedAt IS NULL`   — hard soft-deletes must never surface
 *     - `isDeleted = false`   — legacy soft-delete flag
 *     - `isPublic = true`     — only publicly-discoverable profiles
 *
 *   Tracks:
 *     - `deletedAt IS NULL`   — soft-deleted tracks excluded
 *     - `isPublic = true`     — private tracks excluded
 *     - `artist.deletedAt IS NULL` — tracks whose artist was deleted
 *     - `artist.isDeleted = false`
 *
 *   Artist-status constraints (optional, for status-aware contexts):
 *     - Records with statuses that opt out of discovery can be hidden via
 *       `applyArtistStatusConstraint`.
 */
export class SearchVisibilityPolicy {
  /**
   * Apply public-artist visibility rules to an artist query builder.
   * The alias parameter must match the alias used in the query builder.
   */
  static applyArtistVisibility<T>(
    qb: SelectQueryBuilder<T>,
    alias = 'artist',
  ): SelectQueryBuilder<T> {
    return qb
      .andWhere(`${alias}.deletedAt IS NULL`)
      .andWhere(`${alias}.isDeleted = :visibilityIsDeleted`, {
        visibilityIsDeleted: false,
      })
      .andWhere(`${alias}.isPublic = :visibilityIsPublic`, {
        visibilityIsPublic: true,
      });
  }

  /**
   * Apply public-track visibility rules to a track query builder.
   * Pass `artistAlias` if the artist is already joined and you want to
   * also exclude tracks whose artist is deleted/hidden.
   */
  static applyTrackVisibility<T>(
    qb: SelectQueryBuilder<T>,
    trackAlias = 'track',
    artistAlias?: string,
  ): SelectQueryBuilder<T> {
    qb
      .andWhere(`${trackAlias}.deletedAt IS NULL`)
      .andWhere(`${trackAlias}.isPublic = :trackVisibilityIsPublic`, {
        trackVisibilityIsPublic: true,
      });

    if (artistAlias) {
      qb
        .andWhere(`${artistAlias}.deletedAt IS NULL`)
        .andWhere(`${artistAlias}.isDeleted = :trackArtistIsDeleted`, {
          trackArtistIsDeleted: false,
        });
    }

    return qb;
  }

  /**
   * Optionally restrict search to specific artist status values.
   * By default all non-deleted public artists are included.
   * Callers can pass `excludedStatuses` to hide artists that have opted out
   * of discovery (e.g. `ON_BREAK` or `HIATUS`).
   */
  static applyArtistStatusConstraint<T>(
    qb: SelectQueryBuilder<T>,
    alias = 'artist',
    excludedStatuses: ArtistStatus[] = [],
  ): SelectQueryBuilder<T> {
    if (excludedStatuses.length > 0) {
      qb.andWhere(`${alias}.status NOT IN (:...excludedStatuses)`, {
        excludedStatuses,
      });
    }
    return qb;
  }
}
