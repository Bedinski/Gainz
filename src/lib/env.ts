/**
 * Shared dotenv bootstrap. Loads .env.local first (matches Next.js's
 * convention — README tells operators to put their secrets there), falling
 * back to .env. First file wins per dotenv's array-path semantics, so
 * .env.local overrides .env exactly the way `next dev` treats them.
 *
 * Import this at the top of any tsx-run entry point (worker, scripts):
 *
 *   import './lib/env.js';   // from src/
 *   import '../src/lib/env.js'; // from scripts/
 */
import { config } from 'dotenv';

config({ path: ['.env.local', '.env'] });
