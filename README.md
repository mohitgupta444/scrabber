# ScrapConnect

ScrapConnect is a React + Vite marketplace frontend backed by Supabase. Authentication, account profiles, pickup requests, dealer assignment, status changes, notifications, and pickup chat use the connected Supabase project. Maps use OpenStreetMap tiles through Leaflet and browser geolocation; no paid map key is required.

## Requirements

- Node.js 20.19+ or 22.12+
- A Supabase project
- Browser location permission for nearby dealer search and map pins

## Configure Supabase

1. Create a Supabase project and enable Email provider under **Authentication → Providers**. Configure the confirmation email and redirect URLs for your local and production domains.
2. For a new project, apply every file in `supabase/migrations/` in filename order. For an existing project, apply only migrations that have not already run; for example, if the project is at `0011`, apply `0012_admin_dashboard_analytics.sql`. Prefer the Supabase CLI migration workflow for future schema changes instead of rerunning old migrations.
3. Copy `.env.example` to `.env.local` and fill in the project URL and the **publishable/anon** key from **Project Settings → API**:

   ```dotenv
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-publishable-or-anon-key
   ```

   Only the public publishable/anon key belongs in this frontend. Never put a service-role key or other secret in a `VITE_` variable.

4. Create a normal account using the app. To provision the first administrator, confirm that account and run this in the SQL Editor, replacing the email:

   ```sql
   update public.profiles
   set role = 'admin', verified = true, verification_status = 'approved'
   where id = (
     select id from auth.users where email = 'admin@example.com'
   );
   ```

5. Sign up a dealer account, complete the shop profile, and use the administrator portal to approve it. A dealer must be approved and set a map location before appearing in customer searches or receiving requests.

## Run locally (PowerShell)

This Windows setup may block the `npm.ps1` wrapper. Use `npm.cmd`:

```powershell
cd C:\scrabber
npm.cmd install
npm.cmd run dev
```

Open the local URL printed by Vite, normally `http://localhost:5173`. Browser geolocation works on localhost; deployed sites must use HTTPS.

Other commands:

```powershell
npm.cmd run lint
npm.cmd run test
npm.cmd run build
npm.cmd run preview
```

Restart Vite after changing `.env.local`.

## Functional flows

- Real email/password signup, sign-in, sign-out, email confirmation, and password reset through Supabase Auth.
- Customer pickup requests persisted in PostgreSQL. Photo uploads go to a private Supabase Storage bucket.
- Interactive OpenStreetMap views, map-pin selection, browser geolocation, dealer distance/service-radius filtering, and live dealer location updates while a dealer shares location.
- Verified dealers see privacy-limited open requests. Accept is an atomic database operation so a request can only be assigned once. Customer contact and full address become available to the assigned dealer. Dealer directory results expose only the fields needed by the public listing, through scoped database functions.
- Pickup status and dealer-location changes update over Supabase Realtime.
- A private per-pickup chat is available to the customer and assigned dealer while a pickup is active. Chat access closes when the pickup is completed or cancelled.
- Actual weight and final amount are recorded when the dealer completes a pickup. Price estimates are loaded from the database; the database recalculates the stored estimate on insert.
- Customer transaction history, wallet totals, notifications, nearby dealer views, administrator statistics, and dealer verification read/write the connected project.

## Backend notes

- Database schema and security policies: apply `supabase/migrations/0001_initial_schema.sql` through `0012_admin_dashboard_analytics.sql` in order.
- Supabase client and environment validation: `src/services/supabase.js`
- Authentication, pickup, messaging, prices, profiles, activity, and admin APIs: `src/services/`
- No mock login or local fallback is enabled. Without project credentials and the SQL migration, backend-backed screens intentionally show a configuration/error state.
- In-app wallet transfers use an atomic ledger transfer between registered account emails. A user can send only available app credits; an admin can add audited pilot credits. These credits are not cash, cannot be withdrawn, and are separate from Razorpay pickup payouts.
- When the customer confirms the agreed final amount, the database atomically completes the pickup, debits the dealer wallet, and credits the customer's app wallet. Insufficient dealer balance prevents confirmation/payment. Customers can then transfer received app credits to another registered wallet.
- Dealer-to-customer bank payment is a separate, lower-priority Razorpay Checkout/Route flow. Razorpay pickup payouts are shown in history but do not become transferable app credits. Route requires account approval and linked-account onboarding.
- Real payments require an approved Razorpay account with Route enabled, customer linked-account onboarding, Razorpay API secrets configured in Supabase Functions, and a `payment_recipients` row for each onboarded customer. Until configured, no live payment can run. Use Razorpay test keys and test linked accounts before live mode. Admin commission statistics remain estimates until they are updated to read payment ledger records.
- Pickup confirmation is retry-safe: a repeat request returns the existing successful result; the unique pickup payment row and row locks prevent a second debit/credit.
- Deployment: apply all migrations `0001` through `0012` in order. The wallet transfer and pickup payment RPCs are database-backed and do not require Razorpay credentials. Razorpay bank payout functions remain optional; deploy them and configure their secrets/webhook only when Route is enabled. Never put provider secrets or the service-role key in `.env.local` or browser code.
- OpenStreetMap supplies map tiles. The address is entered by the user; a geocoding provider is not connected. Real turn-by-turn routing is not included.
