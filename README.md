# Deal Watch

Watch Gmail for promotion emails from senders you choose that contain keywords you choose, and get one Telegram digest per check.

Everything runs inside your own Google account. No server, no database, no third-party service, and no shared bot: you deploy your own copy, so your keys stay yours.

## Get started

Setup guide: https://carmenchancky.github.io/deal-watch/

Open the template: https://docs.google.com/spreadsheets/d/1pNb1TCxCix7ublIMJN-R3xNJn_6sjlU_rzRanuQFDno/edit?usp=sharing then choose **File > Make a copy**.

Full documentation lives in the static site under [`docs/`](docs/): Setup, Usage, and FAQ.

## Quick summary

1. Create a bot in BotFather and copy its token.
2. Open the template above and make a copy (**File > Make a copy**).
3. Deploy the Web App from the Sheet's script editor.
4. Run **Deal Watch > Setup** and paste the token and the `/exec` URL.
5. Open the bind link in Telegram to connect your account.

Then use `/add` to create rules and `/interval` to set how often Gmail is checked.

## Updates

Each copy is yours alone, so Deal Watch never updates itself: your `/status` shows your version and flags when a
newer release exists, and you replace the code in your own script by hand. Steps are in
[Updating](https://carmenchancky.github.io/deal-watch/usage.html#updating); changes are listed in
[CHANGELOG.md](CHANGELOG.md). Watch the repository's releases to be notified.
