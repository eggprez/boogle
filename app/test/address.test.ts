import { describe, expect, it } from 'vitest';
import { appleDirections, formatNominatimAddress, formatTagAddress, googleDirections, placeQuery, telHref } from '../src/address.js';

describe('addresses', () => {
  it('formats a US address with the state abbreviation', () => {
    expect(
      formatNominatimAddress({ house_number: '990', road: 'Lincoln Street', city: 'Denver', state: 'Colorado', 'ISO3166-2-lvl4': 'US-CO', postcode: '80203', country: 'United States', country_code: 'us' }),
    ).toBe('990 Lincoln Street, Denver, CO 80203');
  });
  it('formats a non-US address with the country when asked', () => {
    expect(formatNominatimAddress({ road: 'Rua Augusta', city: 'Lisboa', postcode: '1100-053', state: 'Lisboa', country: 'Portugal', country_code: 'pt' }, { country: true })).toBe(
      'Rua Augusta, Lisboa, Lisboa 1100-053, Portugal',
    );
  });
  it('formats OSM addr tags and returns nothing without a street', () => {
    expect(formatTagAddress({ 'addr:housenumber': '1116', 'addr:street': 'Broadway', 'addr:city': 'Denver', 'addr:state': 'CO', 'addr:postcode': '80203' })).toBe('1116 Broadway, Denver, CO 80203');
    expect(formatTagAddress({ 'addr:street': 'Pearl Street' }, 'Denver')).toBe('Pearl Street, Denver');
    expect(formatTagAddress({ name: 'x' })).toBe('');
  });
  it('builds map links on the address, falling back to coordinates', () => {
    const q = placeQuery('Pizza 3.14', '225 East 20th Avenue, Denver, CO', 39.7, -104.9);
    expect(q).toBe('Pizza 3.14, 225 East 20th Avenue, Denver, CO');
    expect(googleDirections(q, { lat: 39.74, lon: -104.99 })).toBe('https://www.google.com/maps/dir/?api=1&origin=39.74000%2C-104.99000&destination=Pizza%203.14%2C%20225%20East%2020th%20Avenue%2C%20Denver%2C%20CO');
    expect(appleDirections(q)).toBe('https://maps.apple.com/?daddr=Pizza%203.14%2C%20225%20East%2020th%20Avenue%2C%20Denver%2C%20CO');
    expect(placeQuery('Somewhere', '', 39.7, -104.9)).toBe('Somewhere @39.70000,-104.90000');
  });
  it('makes a tel: link from a formatted number', () => {
    expect(telHref('+1 303-555-0100')).toBe('tel:+13035550100');
    expect(telHref('(303) 555-0100; (303) 555-0101')).toBe('tel:3035550100');
  });
});
