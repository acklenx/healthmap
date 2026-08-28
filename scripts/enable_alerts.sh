#!/usr/bin/env bash
# Turn on push alerts for saved places.
#
# Everything else is already written and tested -- web/functions/api/{subscribe,
# notify,pending}.js, _push.js, the schema, the key generator, and the workflow
# step that fires them. The only thing standing between Save doing nothing and
# Save being useful is a database that exists and three secrets.
#
# Needs `npx wrangler login` first. Run from the repository root.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "1/4  Creating the D1 database…"
npx wrangler d1 create healthmap || echo "     (already exists, carrying on)"

echo
echo "     Paste the database_id above into web/wrangler.toml and uncomment the"
echo "     [[d1_databases]] block, then press enter."
read -r _

echo "2/4  Applying the schema…"
npx wrangler d1 execute healthmap --remote --file=web/schema.sql

echo "3/4  Generating a VAPID key pair…"
node scripts/gen_vapid.mjs | tee /tmp/vapid.txt

echo
echo "4/4  Setting the secrets. You'll be prompted for each; copy from above."
cd web
for name in VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY; do
  echo "     -> $name"
  npx wrangler pages secret put "$name" --project-name healthmap
done

SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')
echo "     -> NOTIFY_SECRET (generated: $SECRET)"
printf '%s' "$SECRET" | npx wrangler pages secret put NOTIFY_SECRET --project-name healthmap

cat <<DONE

Done here. Two things left, both on github.com:

  Settings -> Secrets and variables -> Actions
    NOTIFY_SECRET   $SECRET
    APP_ORIGIN      https://healthmap.acklenx.com

Then set VAPID_SUBJECT in web/wrangler.toml to a real mailbox, commit, and the
next crawl will start sending alerts for saved places.

On iOS, web push only works once the app is on the home screen.
DONE
