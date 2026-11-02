# TEXHORU price monitoring architecture

The monitor is split by responsibility. Store-specific code implements one shared contract; matching and persistence do not depend on a retailer's page layout.

## 1. 1C Import
- Existing integration boundary: `server/src/integrations/`.
- Imports the 1C catalog and category hierarchy.
- Matching jobs include only active 1C-linked products with a positive price and available stock (`stockQty > reservedQty`).
- A later integration task will move the same eligibility filter into the user's real 1C export, after inspecting its actual stock, reservation and price registers. Do not guess those register names or alter the live 1C configuration before that review.

## 2. Product Intelligence
- `server/src/price-monitor/product-matching.ts`.
- Normalizes product names, aliases, model identifiers, RAM, storage, color, SIM, GTIN and MPN.
- Handles paired RAM/ROM labels such as DNS `8 ГБ / 256 ГБ`.

## 3. Discovery and Catalog Index
- Shared contract and retailer adapters: `server/src/price-monitor/storefront-adapter.ts`.
- For 05.ru, the first smartphone matching run builds a persistent, paginated index of the public smartphone category before processing `MATCH_1C` jobs.
- `FiveRuParser.indexSmartphoneCatalogPage()` reads one category page per worker tick. `CompetitorCatalogEntry` stores the URL, title, normalized model, storage, color and last-seen timestamp. A completed index is reused for up to seven days.
- The index is a discovery layer, not a price source. Only likely candidates are opened to read full product-page characteristics, price and availability. If the index has no candidate, the existing public live-search path remains a fallback.
- M.Video and DNS use their own public search pages, product URL validators and page selectors. Adapters accept only HTTPS pages on official retailer domains and do not bypass access restrictions.

## 4. Matching Engine
- `server/src/price-monitor/matching-engine.ts`.
- Pure decision logic: no browser, database or scheduler access.
- Exact, unique variants can be auto-confirmed. Ambiguous or incomplete variants remain for human review.

## 5. Mapping Database
- Prisma models: `CompetitorSource`, `CompetitorProduct`, `CompetitorCatalogEntry`, `CompetitorPriceHistory`, `MonitorJob`, `MonitorSettings`.
- Every confirmed link belongs to one retailer source and one 1C product.
- Confirmed mappings retain fingerprints so a changed product variant is sent back for review.

## 6. Price Monitor
- Orchestration and scheduling: `server/src/price-monitor/price-monitor.service.ts`.
- Initial discovery and catalog indexing use separate persistent jobs.
- Price refresh reads only saved, confirmed URLs. It never starts discovery.
- Each retailer has an independent six-hour schedule and regional setting.
- M.Video and DNS require an explicit city before discovery or price refresh. The selected city is stored with the observation.
- No price is written back to 1C or the storefront automatically. Existing explicit preview/confirmation flows remain separate.

## Supported retailers

| Source | Official product URL pattern |
|---|---|
| 05.ru | Existing 05.ru product cards |
| M.Video | `https://www.mvideo.ru/products/{id}` |
| DNS | `https://www.dns-shop.ru/product/{hex-id}/{slug}/` |

## Operational sequence

1. Import the current 1C catalog.
2. Set the city separately in the M.Video and DNS tabs.
3. Start initial matching. If the 1C selection contains smartphones, TEXHORU indexes the public 05.ru smartphone category first, then matches against the local index.
4. Review and confirm ambiguous matches.
5. Enable six-hour price checks per retailer.
6. Apply any storefront or 1C price change only through the existing explicit confirmation flow.
