/**
 * Regional Geolocation & IP presets for bypassing GeoIP redirects
 * Covers all African markets.
 */
export const GEO_PRESETS = {
  // --- African Markets ---
  ZA: {
    countryCode: 'ZA',
    countryName: 'South Africa',
    flag: '🇿🇦',
    locale: 'en-ZA',
    timezoneId: 'Africa/Johannesburg',
    geolocation: { latitude: -26.2041, longitude: 28.0473 },
    ip: '196.25.1.1'
  },
  BW: {
    countryCode: 'BW',
    countryName: 'Botswana',
    flag: '🇧🇼',
    locale: 'en-BW',
    timezoneId: 'Africa/Gaborone',
    geolocation: { latitude: -24.6282, longitude: 25.9231 },
    ip: '168.167.0.1'
  },
  GH: {
    countryCode: 'GH',
    countryName: 'Ghana',
    flag: '🇬🇭',
    locale: 'en-GH',
    timezoneId: 'Africa/Accra',
    geolocation: { latitude: 5.6037, longitude: -0.1870 },
    ip: '154.160.0.1'
  },
  KE: {
    countryCode: 'KE',
    countryName: 'Kenya',
    flag: '🇰🇪',
    locale: 'en-KE',
    timezoneId: 'Africa/Nairobi',
    geolocation: { latitude: -1.2921, longitude: 36.8219 },
    ip: '197.232.0.1'
  },
  NG: {
    countryCode: 'NG',
    countryName: 'Nigeria',
    flag: '🇳🇬',
    locale: 'en-NG',
    timezoneId: 'Africa/Lagos',
    geolocation: { latitude: 6.5244, longitude: 3.3792 },
    ip: '197.210.0.1'
  },
  TZ: {
    countryCode: 'TZ',
    countryName: 'Tanzania',
    flag: '🇹🇿',
    locale: 'en-TZ',
    timezoneId: 'Africa/Dar_es_Salaam',
    geolocation: { latitude: -6.7924, longitude: 39.2083 },
    ip: '196.43.224.1'
  },
  ZM: {
    countryCode: 'ZM',
    countryName: 'Zambia',
    flag: '🇿🇲',
    locale: 'en-ZM',
    timezoneId: 'Africa/Lusaka',
    geolocation: { latitude: -15.3875, longitude: 28.3228 },
    ip: '41.77.0.1'
  },
  UG: {
    countryCode: 'UG',
    countryName: 'Uganda',
    flag: '🇺🇬',
    locale: 'en-UG',
    timezoneId: 'Africa/Kampala',
    geolocation: { latitude: 0.3476, longitude: 32.5825 },
    ip: '197.239.0.1'
  },
  MZ: {
    countryCode: 'MZ',
    countryName: 'Mozambique',
    flag: '🇲🇿',
    locale: 'pt-MZ',
    timezoneId: 'Africa/Maputo',
    geolocation: { latitude: -25.9692, longitude: 32.5732 },
    ip: '196.28.224.1'
  },
  MW: {
    countryCode: 'MW',
    countryName: 'Malawi',
    flag: '🇲🇼',
    locale: 'en-MW',
    timezoneId: 'Africa/Blantyre',
    geolocation: { latitude: -15.7861, longitude: 35.0058 },
    ip: '197.218.0.1'
  },
  CD: {
    countryCode: 'CD',
    countryName: 'DR Congo',
    flag: '🇨🇩',
    locale: 'fr-CD',
    timezoneId: 'Africa/Kinshasa',
    geolocation: { latitude: -4.4419, longitude: 15.2663 },
    ip: '41.243.0.1'
  },
  AO: {
    countryCode: 'AO',
    countryName: 'Angola',
    flag: '🇦🇴',
    locale: 'pt-AO',
    timezoneId: 'Africa/Luanda',
    geolocation: { latitude: -8.8390, longitude: 13.2894 },
    ip: '196.11.236.1'
  },
  ZW: {
    countryCode: 'ZW',
    countryName: 'Zimbabwe',
    flag: '🇿🇼',
    locale: 'en-ZW',
    timezoneId: 'Africa/Harare',
    geolocation: { latitude: -17.8252, longitude: 31.0335 },
    ip: '197.221.224.1'
  },
  SN: {
    countryCode: 'SN',
    countryName: 'Senegal',
    flag: '🇸🇳',
    locale: 'fr-SN',
    timezoneId: 'Africa/Dakar',
    geolocation: { latitude: 14.7167, longitude: -17.4677 },
    ip: '197.214.160.1'
  },
  CM: {
    countryCode: 'CM',
    countryName: 'Cameroon',
    flag: '🇨🇲',
    locale: 'fr-CM',
    timezoneId: 'Africa/Douala',
    geolocation: { latitude: 4.0511, longitude: 9.7679 },
    ip: '195.24.192.1'
  },
  CI: {
    countryCode: 'CI',
    countryName: "Côte d'Ivoire",
    flag: '🇨🇮',
    locale: 'fr-CI',
    timezoneId: 'Africa/Abidjan',
    geolocation: { latitude: 5.3600, longitude: -4.0083 },
    ip: '160.154.0.1'
  },

  // --- Global Markets ---
  GB: {
    countryCode: 'GB',
    countryName: 'United Kingdom',
    flag: '🇬🇧',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    geolocation: { latitude: 51.5074, longitude: -0.1278 },
    ip: '81.2.69.142'
  },
  US: {
    countryCode: 'US',
    countryName: 'United States',
    flag: '🇺🇸',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7128, longitude: -74.0060 },
    ip: '208.67.222.222'
  },
  CA: {
    countryCode: 'CA',
    countryName: 'Canada',
    flag: '🇨🇦',
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    geolocation: { latitude: 43.6532, longitude: -79.3832 },
    ip: '142.250.0.1'
  },
  AU: {
    countryCode: 'AU',
    countryName: 'Australia',
    flag: '🇦🇺',
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    geolocation: { latitude: -33.8688, longitude: 151.2093 },
    ip: '1.1.1.1'
  },
  DE: {
    countryCode: 'DE',
    countryName: 'Germany',
    flag: '🇩🇪',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    geolocation: { latitude: 52.5200, longitude: 13.4050 },
    ip: '91.198.174.192'
  },
  IT: {
    countryCode: 'IT',
    countryName: 'Italy',
    flag: '🇮🇹',
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    geolocation: { latitude: 41.9028, longitude: 12.4964 },
    ip: '151.1.1.1'
  },
  ES: {
    countryCode: 'ES',
    countryName: 'Spain',
    flag: '🇪🇸',
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    geolocation: { latitude: 40.4168, longitude: -3.7038 },
    ip: '212.106.0.1'
  }
};

/**
 * Auto-detect region preset from URL hostname / TLD
 */
export function detectRegionFromUrl(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname.toLowerCase();
    
    // African TLDs & Subdomains
    if (hostname.endsWith('.bw') || hostname.includes('.co.bw')) return GEO_PRESETS.BW;
    if (hostname.endsWith('.za') || hostname.includes('.co.za')) return GEO_PRESETS.ZA;
    if (hostname.endsWith('.gh') || hostname.includes('.com.gh')) return GEO_PRESETS.GH;
    if (hostname.endsWith('.ke') || hostname.includes('.co.ke')) return GEO_PRESETS.KE;
    if (hostname.endsWith('.ng') || hostname.includes('.com.ng') || hostname.endsWith('.ng')) return GEO_PRESETS.NG;
    if (hostname.endsWith('.tz') || hostname.includes('.co.tz')) return GEO_PRESETS.TZ;
    if (hostname.endsWith('.zm') || hostname.includes('.co.zm')) return GEO_PRESETS.ZM;
    if (hostname.endsWith('.ug') || hostname.includes('.co.ug')) return GEO_PRESETS.UG;
    if (hostname.endsWith('.mz') || hostname.includes('.co.mz')) return GEO_PRESETS.MZ;
    if (hostname.endsWith('.mw') || hostname.includes('.co.mw')) return GEO_PRESETS.MW;
    if (hostname.endsWith('.cd')) return GEO_PRESETS.CD;
    if (hostname.endsWith('.ao') || hostname.includes('.co.ao')) return GEO_PRESETS.AO;
    if (hostname.endsWith('.zw') || hostname.includes('.co.zw')) return GEO_PRESETS.ZW;
    if (hostname.endsWith('.sn')) return GEO_PRESETS.SN;
    if (hostname.endsWith('.cm')) return GEO_PRESETS.CM;
    if (hostname.endsWith('.ci')) return GEO_PRESETS.CI;

    // Global
    if (hostname.endsWith('.uk') || hostname.includes('.co.uk')) return GEO_PRESETS.GB;
    if (hostname.endsWith('.ca')) return GEO_PRESETS.CA;
    if (hostname.endsWith('.au') || hostname.includes('.com.au')) return GEO_PRESETS.AU;
    if (hostname.endsWith('.de')) return GEO_PRESETS.DE;
    if (hostname.endsWith('.it')) return GEO_PRESETS.IT;
    if (hostname.endsWith('.es')) return GEO_PRESETS.ES;
    if (hostname.endsWith('.us')) return GEO_PRESETS.US;
    
    return null;
  } catch (e) {
    return null;
  }
}
