# TEXHORU price monitoring architecture

The monitor is split by responsibility. Store-specific code implements one shared contract; matching and persistence do not depend on a retailer's page layout.

## 1. 1C Import
- Existing integration boundary: `server/src/integrations/`.
- Imports the 1C catalog and category hierarchy.
- Discovery uses active products with a positive price and available stock only.

## 2. Product Intelligence
- `server/src/price-monitor/product-matching.ts`.
- Normalizes product names, aliases, model identifiers, RAM, storage, color, SIM, GTIN and MPN.
- Handles paired RAM/ROM labels such as DNS `8 ГБ / 256 ГБ`.

## 3. Discovery Engine
- Shared contract and retailer adapters: `server/src/price-monitor/storefront-adapter.ts`.
- Existing 05.ru discovery remains in `five-ru.parser.ts` and `search-discovery.ts`.
- M.Video and DNS use their own official search pages, product URL validators and page selectors.
- The adapters accept only HTTPS pages on the retailer's official domains. They do not bypass access restrictions.

## 4. Matching Engine
- `server/src/price-monitor/matching-engine.ts`.
- Pure decision logic: no browser, database or scheduler access.
- Exact, unique variants can be auto-confirmed. Ambiguous or incomplete variants remain for human review.

## 5. Mapping Database
- Prisma models: `CompetitorSource`, `CompetitorProduct`, `CompetitorPriceHistory`, `MonitorJob`, `MonitorSettings`.
- Every link belongs to one retailer source and one 1C product.
- Confirmed mappings retain fingerprints so a changed product variant is sent back for review.

## 6. Price Monitor
- Orchestration and scheduling: `server/src/price-monitor/price-monitor.service.ts`.
- Initial discovery creates separate jobs per retailer.
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
3. Run initial matching across the retailers.
4. Review and confirm ambiguous matches.
5. Enable six-hour price checks per retailer.
6. Apply any storefront or 1C price change only through the existing explicit confirmation flow.
