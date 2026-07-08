# create-minvoice

Scaffold a self-hosted [Minvoice](https://github.com/ddyy/minvoice) deployment — minimal
single-business invoicing that runs entirely on Cloudflare (Workers, D1, Stripe & PayPal
hosted checkout, PDF invoices, payment reminders).

```sh
npm create minvoice            # scaffolds into ./minvoice
npm create minvoice my-books   # or pick a directory
```

Downloads the latest Minvoice, installs dependencies, starts a fresh git history, and prints
the three-step deploy (create a D1 database, set an admin password, `npm run deploy`).

No dependencies; needs Node 18+ and `tar` (preinstalled on macOS, Linux, and Windows 10+).

Full setup — payments, email, Cloudflare Access, custom domains, staging:
https://github.com/ddyy/minvoice#setup
