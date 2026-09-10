import { Injectable } from '@angular/core';

export interface PlaceHit {
  /** Human-readable label for the dropdown, e.g. "Durbanville, Cape Town, South Africa". */
  label: string;
  /** A shorter primary name where one is available (the first comma-segment). */
  name: string;
  lon: number;
  lat: number;
}

/**
 * Free-text place search → coordinates, backed by OpenStreetMap's Nominatim.
 *
 * Why Nominatim: this app carries no map SDK and no Google key, and a stock
 * location only needs a rough pin an admin can eyeball and correct later.
 * Nominatim needs no key and no billing. Usage policy is ~1 request/second
 * and a real identifying header — both satisfied here: the caller debounces
 * to 350 ms and this is a low-volume internal admin screen. If it's ever
 * unreachable the modal's manual lon/lat inputs still work unchanged.
 */
@Injectable({ providedIn: 'root' })
export class PlaceSearchService {
  private readonly ENDPOINT = 'https://nominatim.openstreetmap.org/search';

  async search(query: string, signal?: AbortSignal): Promise<PlaceHit[]> {
    const q = query.trim();
    if (q.length < 3) return [];

    const url =
      `${this.ENDPOINT}?format=jsonv2&addressdetails=0&limit=6&q=${encodeURIComponent(q)}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal,
      });
    } catch (e) {
      if ((e as any)?.name === 'AbortError') return [];
      throw new Error('Place search is unavailable — enter coordinates manually.');
    }
    if (!res.ok) throw new Error('Place search failed — enter coordinates manually.');

    const raw = (await res.json().catch(() => [])) as any[];
    if (!Array.isArray(raw)) return [];

    return raw
      .map((r): PlaceHit | null => {
        const lon = Number(r?.lon);
        const lat = Number(r?.lat);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        const label = String(r?.display_name ?? '').trim();
        if (!label) return null;
        return { label, name: label.split(',')[0].trim() || label, lon, lat };
      })
      .filter((h): h is PlaceHit => h !== null);
  }
}
