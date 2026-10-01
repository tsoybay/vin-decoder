# VIN Decoder and Recall Checker

A free, no-login web tool that decodes a 17-character Vehicle Identification Number (VIN), lists US safety recalls for that make, model and year, and links to Transport Canada's official recall lookup.

Built for people shopping for a used car in Canada, including on a phone in a dealership lot.

**Live demo:** _add your GitHub Pages link here_

![Screenshot of the VIN decoder](screenshot.png)

## What it does

1. **Checks the VIN locally.** Confirms 17 characters, rejects the letters I, O and Q (never used in VINs), and verifies the check digit in position 9 to catch typos. No network needed for this step.
2. **Decodes the vehicle.** Year, make, model, trim, body, drivetrain, engine, fuel, transmission and where it was assembled, from NHTSA's vPIC API.
3. **Lists US recalls.** Looks up recalls by make, model and year with NHTSA's recalls API, newest first, with the component, risk and fix for each.
4. **Points to Canada.** Links to Transport Canada's recalls page, which includes a search by VIN, and copies the VIN so it can be pasted there.
5. **Handles problems clearly.** Bad VIN, no internet, a slow API, or a vehicle NHTSA doesn't recognize each get a plain message instead of a broken page.

You can also copy the report as text or print it.

## Limitations (read these)

- **Recalls are matched by make, model and year, not by VIN.** The tool shows what recalls exist for this kind of vehicle. It cannot tell you whether this exact car was affected or already repaired. Use Transport Canada's VIN lookup or the manufacturer for that.
- **The recalls shown are US recalls.** Canadian recalls can differ.
- **Vehicles built for other markets** (Europe, Japan) often come back with little or no data, because NHTSA's data covers vehicles sold in North America. Many of those VINs also fail the North American check digit test, so the tool shows a warning instead of blocking the lookup.
- **Model names can differ** between NHTSA's VIN decoder and its recall database. The tool retries once with NHTSA's own spelling and tells you when it does.

For information only. Always confirm recalls with the manufacturer or Transport Canada.

## Troubleshooting

- **"Could not reach NHTSA" with a working connection:** the browser is probably blocking the request (a rule called CORS, or a content security policy on the host). Open the browser console (F12) and look for a red error mentioning `Access-Control-Allow-Origin` or `Content Security Policy`.
- **A field shows blank:** NHTSA only returns what manufacturers submitted. Missing values mean NHTSA has no data, not that the feature is absent.

## Tech

Plain HTML, CSS and JavaScript. No framework, no build step, no API keys.

```
vin-decoder/
├── index.html   page structure
├── style.css    styling
├── script.js    VIN validation, API calls, rendering
└── README.md
```

## Run it locally

Open `index.html` in a browser. If your browser blocks requests from a file, run a tiny local server instead:

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Test the validation logic

The VIN validation is plain functions you can run in Node:

```bash
node -e "const s=require('./script.js'); console.log(s.validateVin('1HGCM82633A004352'))"
```

## Publish with GitHub Pages

1. Push these files to a new repository on your GitHub account.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, then save.
4. After a minute your site is live at `https://YOUR-USERNAME.github.io/REPOSITORY-NAME/`. Paste that link at the top of this README.

## Data sources

- [NHTSA vPIC API](https://vpic.nhtsa.dot.gov/api/) for VIN decoding
- [NHTSA recalls API](https://www.nhtsa.gov/nhtsa-datasets-and-apis) for US recalls
- [Transport Canada recalls](https://tc.canada.ca/en/road-transportation/defects-recalls-vehicles-tires-child-car-seats) for the official Canadian lookup (linked, not queried)

## Roadmap

- **Version 2:** Show Canadian recalls inside the tool using Transport Canada's open recall data (published under the Open Government Licence – Canada), prepared by a small script into a compact JSON file.
- Decode many VINs at once from a CSV file, for dealerships
- Save recent lookups in the browser
- French language toggle
- Scan a VIN barcode with the phone camera
