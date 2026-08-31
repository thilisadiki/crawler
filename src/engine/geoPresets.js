/**
 * Regional Geolocation & IP presets for bypassing GeoIP redirects
 */
export const GEO_PRESETS = {
  GH: {
    countryCode: 'GH',
    countryName: 'Ghana',
    locale: 'en-GH',
    timezoneId: 'Africa/Accra',
    geolocation: { latitude: 5.6037, longitude: -0.1870 },
    ip: '154.160.0.1'
  },
  ZA: {
    countryCode: 'ZA',
    countryName: 'South Africa',
    locale: 'en-ZA',
    timezoneId: 'Africa/Johannesburg',
    geolocation: { latitude: -26.2041, longitude: 28.0473 },
    ip: '196.25.1.1'
  },
  KE: {
    countryCode: 'KE',
    countryName: 'Kenya',
    locale: 'en-KE',
    timezoneId: 'Africa/Nairobi',
    geolocation: { latitude: -1.2921, longitude: 36.8219 },
    ip: '197.232.0.1'
  },
  NG: {
    countryCode: 'NG',
    countryName: 'Nigeria',
    locale: 'en-NG',
    timezoneId: 'Africa/Lagos',
    geolocation: { latitude: 6.5244, longitude: 3.3792 },
    ip: '197.210.0.1'
  },
  TZ: {
    countryCode: 'TZ',
    countryName: 'Tanzania',
    locale: 'en-TZ',
    timezoneId: 'Africa/Dar_es_Salaam',
    geolocation: { latitude: -6.7924, longitude: 39.2083 },
    ip: '196.43.224.1'
  },
  ZM: {
    countryCode: 'ZM',
    countryName: 'Zambia',
    locale: 'en-ZM',
    timezoneId: 'Africa/Lusaka',
    geolocation: { latitude: -15.3875, longitude: 28.3228 },
    ip: '41.77.0.1'
  },
  UG: {
    countryCode: 'UG',
    countryName: 'Uganda',
    locale: 'en-UG',
    timezoneId: 'Africa/Kampala',
    geolocation: { latitude: 0.3476, longitude: 32.5825 },
    ip: '197.239.0.1'
  },
  MZ: {
    countryCode: 'MZ',
    countryName: 'Mozambique',
    locale: 'pt-MZ',
    timezoneId: 'Africa/Maputo',
    geolocation: { latitude: -25.9692, longitude: 32.5732 },
    ip: '196.28.224.1'
  },
  MW: {
    countryCode: 'MW',
    countryName: 'Malawi',
    locale: 'en-MW',
    timezoneId: 'Africa/Blantyre',
    geolocation: { latitude: -15.7861, longitude: 35.0058 },
    ip: '197.218.0.1'
  },
  GB: {
    countryCode: 'GB',
    countryName: 'United Kingdom',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    geolocation: { latitude: 51.5074, longitude: -0.1278 },
    ip: '81.2.69.142'
  },
  US: {
    countryCode: 'US',
    countryName: 'United States',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7128, longitude: -74.0060 },
    ip: '208.67.222.222'
  }
};

/**
 * Auto-detect region preset from URL hostname / TLD
 */
export function detectRegionFromUrl(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname.toLowerCase();
    
    if (hostname.endsWith('.gh') || hostname.includes('.com.gh')) return GEO_PRESETS.GH;
    if (hostname.endsWith('.za') || hostname.includes('.co.za')) return GEO_PRESETS.ZA;
    if (hostname.endsWith('.ke') || hostname.includes('.co.ke')) return GEO_PRESETS.KE;
    if (hostname.endsWith('.ng') || hostname.includes('.com.ng')) return GEO_PRESETS.NG;
    if (hostname.endsWith('.tz') || hostname.includes('.co.tz')) return GEO_PRESETS.TZ;
    if (hostname.endsWith('.zm') || hostname.includes('.co.zm')) return GEO_PRESETS.ZM;
    if (hostname.endsWith('.ug') || hostname.includes('.co.ug')) return GEO_PRESETS.UG;
    if (hostname.endsWith('.mz') || hostname.includes('.co.mz')) return GEO_PRESETS.MZ;
    if (hostname.endsWith('.mw') || hostname.includes('.co.mw')) return GEO_PRESETS.MW;
    if (hostname.endsWith('.uk') || hostname.includes('.co.uk')) return GEO_PRESETS.GB;
    if (hostname.endsWith('.us')) return GEO_PRESETS.US;
    
    return null;
  } catch (e) {
    return null;
  }
}
