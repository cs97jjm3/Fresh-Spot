// === FreshStop config (secrets; DO NOT COMMIT) ===
window.CONFIG = Object.assign(window.CONFIG || {}, {
  PROXY_BASE: "https://dry-frog-1fcd.murrell-james.workers.dev"
});
// Met Office Weather DataHub (Global Spot Site-Specific)
window.CONFIG = {
  METOFFICE: {
    ENABLED: true,
    BASE: "https://data.hub.api.metoffice.gov.uk/sitespecific/v0",
    API_KEY: "eyJ4NXQjUzI1NiI6Ik5XVTVZakUxTkRjeVl6a3hZbUl4TkdSaFpqSmpOV1l6T1dGaE9XWXpNMk0yTWpRek5USm1OVEE0TXpOaU9EaG1NVFJqWVdNellXUm1ZalUyTTJJeVpBPT0iLCJraWQiOiJnYXRld2F5X2NlcnRpZmljYXRlX2FsaWFzIiwidHlwIjoiSldUIiwiYWxnIjoiUlMyNTYifQ==.eyJzdWIiOiJtdXJyZWxsLmphbWVzQGdtYWlsLmNvbUBjYXJib24uc3VwZXIiLCJhcHBsaWNhdGlvbiI6eyJvd25lciI6Im11cnJlbGwuamFtZXNAZ21haWwuY29tIiwidGllclF1b3RhVHlwZSI6bnVsbCwidGllciI6IlVubGltaXRlZCIsIm5hbWUiOiJhdG1vc3BoZXJpYy1lYmI3NzgwMS0xOTZkLTQ1OGQtODVlYS1jNmQwNmZkMzEyNjEiLCJpZCI6MjQwNDAsInV1aWQiOiIxODVlOTMyOS04MTkzLTQwZTAtYWJlOS0yMmI0MTU2ZjYwOTcifSwiaXNzIjoiaHR0cHM6XC9cL2FwaS1tYW5hZ2VyLmFwaS1tYW5hZ2VtZW50Lm1ldG9mZmljZS5jbG91ZDo0NDNcL29hdXRoMlwvdG9rZW4iLCJ0aWVySW5mbyI6eyJ3ZGhfYXRtb3NwaGVyaWNfZnJlZSI6eyJ0aWVyUXVvdGFUeXBlIjoicmVxdWVzdENvdW50IiwiZ3JhcGhRTE1heENvbXBsZXhpdHkiOjAsImdyYXBoUUxNYXhEZXB0aCI6MCwic3RvcE9uUXVvdGFSZWFjaCI6dHJ1ZSwic3Bpa2VBcnJlc3RMaW1pdCI6MCwic3Bpa2VBcnJlc3RVbml0Ijoic2VjIn19LCJrZXl0eXBlIjoiUFJPRFVDVElPTiIsInN1YnNjcmliZWRBUElzIjpbeyJzdWJzY3JpYmVyVGVuYW50RG9tYWluIjoiY2FyYm9uLnN1cGVyIiwibmFtZSI6ImF0bW9zcGhlcmljLW1vZGVscyIsImNvbnRleHQiOiJcL2F0bW9zcGhlcmljLW1vZGVsc1wvMS4wLjAiLCJwdWJsaXNoZXIiOiJXREhfQ0kiLCJ2ZXJzaW9uIjoiMS4wLjAiLCJzdWJzY3JpcHRpb25UaWVyIjoid2RoX2F0bW9zcGhlcmljX2ZyZWUifV0sInRva2VuX3R5cGUiOiJhcGlLZXkiLCJpYXQiOjE3NTcwMDY1MTAsImp0aSI6ImY0Y2JlNjc5LWVlNDctNGM5OC04OWUyLTg0NWVjNGJmNTE0ZCJ9.YRHAQDnEbWzGzl5RcL84ocaDWmIr4Kkg5Lewd7I9wOsWr8aMCzVt5-XnhMHIZkaDr-IxUG5Q4_82vxfYULqeyNY8Obuo8dygI7Rms_H-16RexdiEDavDlEPwaJlQ-D4BhXAXfaj-7wmcaohuSbWpVVImACuIlFSVOfDDk1Yp6gzfYhzSAmgaUDkSb8oiNCghwDS0QaBr_I1Q20jtPG3mV3_kj5Uvy0wOdFMaPf9ngDL6PVpa4OQ7SPmx_MTF8oT82sO8ETz5N3orEb1S5n86grUOdwaMquAILdqWwmU8zdn6V-YkjZ6vpKRywwhnjITxDstf4njstTob5KKc_sncWw==",
    SHOW_INLINE: true // keep weather hidden by default; if true shows tiny summary in stop popups
  },

  // Open-Meteo Air Quality (no key required)
  OPEN_METEO_AQ: {
    ENABLED: true,
    BASE: "https://air-quality-api.open-meteo.com/v1/air-quality"
  },

  // TfL Unified API (optional; improves London stops + live arrivals)
  TFL: {
    ENABLED: true,

    // Unified API (StopPoint/Line/Arrivals etc.)
    APP_ID: "",                                  // optional
    APP_KEY: "015957588b78493ea496bf478049a0fb", // your portal key

    // Azure APIM subscription (Trackernet / APIM products)
    SUBSCRIPTION_KEY: "77b770920d254535ba4c50e9f1a7c2b3b8"
  },

  // BODS / SIRI-VM (optional; usually via backend/proxy due to CORS)
  BODS: {
    ENABLED: true,
    API_KEY: "4da209fe2ceb2ffa6d73ca9a91968e27535b841c"
  },

  // Optional NaPTAN static JSON (preprocessed subset; e.g. /data/naptan-stops.min.json)
  NAPTAN: {
    STATIC_JSON_URL: "" // leave blank to skip; Overpass + TfL will be used
  },

  // Routing & data sources
  OSRM_BASE: "https://router.project-osrm.org/route/v1/walking",
  OVERPASS_URL: "https://overpass-api.de/api/interpreter",

  // UI defaults
  SEARCH_RADIUS_METERS: 800
};
