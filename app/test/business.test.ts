import { describe, expect, it } from 'vitest';
import { addressFromTitle, extractBusiness, hoursFromLd, jsonLdObjects, pickCandidates } from '../src/business.js';

const hits = [
  { url: 'https://www.opossumpikevet.com/', title: 'Home - Opossum Pike Vet Clinic & Animal Hospital' },
  { url: 'https://www.opossumpikevet.com/contact/', title: 'Contact Us - Opossum Pike Vet Clinic & Animal Hospital' },
  { url: 'https://www.opossumpikevet.com/staff/', title: 'Staff - Opossum Pike Vet Clinic & Animal Hospital' },
  { url: 'https://www.mapquest.com/us/maryland/opossum-pike-veterinary-clinic-21746924', title: 'Opossum Pike Veterinary Clinic, 1550 Opossumtown Pike, Frederick, MD 21702 - MapQuest' },
  { url: 'https://www.jabaras.com/shop-flooring-online/x', title: 'CALI ALL STAR FREE DIVE | Jabara\'s' },
];

describe('pickCandidates', () => {
  it('prefers the business site (home, then contact) over directories and drops unrelated hits', () => {
    const picked = pickCandidates('Opossumtown Pike Vet Hospital', hits);
    expect(picked.map((h) => h.url)).toEqual([
      'https://www.opossumpikevet.com/',
      'https://www.opossumpikevet.com/contact/',
      'https://www.mapquest.com/us/maryland/opossum-pike-veterinary-clinic-21746924',
    ]);
  });
  it('needs a distinctive word to match, not just "vet" or "hospital"', () => {
    expect(pickCandidates('Opossumtown Pike Vet Hospital', [{ url: 'https://a.com/', title: 'Best Vet Hospital Rankings' }])).toEqual([]);
  });
});

describe('extractBusiness', () => {
  it('reads schema.org LocalBusiness JSON-LD with hours and geo', () => {
    const html = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"VeterinaryCare","name":"Opossum Pike Vet Clinic","telephone":"+1-301-555-0100","url":"https://www.opossumpikevet.com/","image":"https://www.opossumpikevet.com/logo.png","address":{"@type":"PostalAddress","streetAddress":"1550 Opossumtown Pike","addressLocality":"Frederick","addressRegion":"MD","postalCode":"21702","addressCountry":"US"},"geo":{"@type":"GeoCoordinates","latitude":39.44,"longitude":-77.43},"openingHoursSpecification":[{"@type":"OpeningHoursSpecification","dayOfWeek":["Monday","Tuesday","Wednesday","Thursday","Friday"],"opens":"08:00","closes":"18:00"},{"@type":"OpeningHoursSpecification","dayOfWeek":"Saturday","opens":"08:00","closes":"12:00"}]}</script></head><body></body></html>`;
    const b = extractBusiness(html, 'https://www.opossumpikevet.com/contact/')!;
    expect(b).toMatchObject({
      name: 'Opossum Pike Vet Clinic',
      address: '1550 Opossumtown Pike, Frederick, MD 21702',
      phone: '+1-301-555-0100',
      website: 'https://www.opossumpikevet.com/',
      lat: 39.44,
      lon: -77.43,
      kind: 'veterinary care',
      image: 'https://www.opossumpikevet.com/logo.png',
    });
    expect(b.weekdayHours).toEqual([
      'Monday: 8:00 AM–6:00 PM',
      'Tuesday: 8:00 AM–6:00 PM',
      'Wednesday: 8:00 AM–6:00 PM',
      'Thursday: 8:00 AM–6:00 PM',
      'Friday: 8:00 AM–6:00 PM',
      'Saturday: 8:00 AM–12:00 PM',
      'Sunday: Closed',
    ]);
  });
  it('walks @graph and picks the object with an address', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"WebSite","name":"x"},{"@type":"Dentist","name":"Smile Co","address":{"streetAddress":"12 Main St","addressLocality":"Boise","addressRegion":"ID","postalCode":"83702"},"telephone":"(208) 555-0199"}]}</script>`;
    expect(extractBusiness(html, 'https://smile.example/')).toMatchObject({ name: 'Smile Co', address: '12 Main St, Boise, ID 83702', phone: '(208) 555-0199', kind: 'dentist' });
  });
  it('falls back to a US address and phone in the page text', () => {
    const html = `<html><body><h1>Corner Bakery</h1><p>Visit us at 225 East 20th Avenue, Denver, CO 80205</p><p>Call (303) 555-0142 today</p></body></html>`;
    expect(extractBusiness(html, 'https://corner.example/')).toMatchObject({ address: '225 East 20th Avenue, Denver, CO 80205', phone: '(303) 555-0142', city: 'Denver', region: 'CO' });
  });
  it('returns null for a page with no address', () => {
    expect(extractBusiness('<html><body><p>Welcome to our blog.</p></body></html>', 'https://x.example/')).toBeNull();
  });
});

describe('hoursFromLd and addressFromTitle', () => {
  it('reads "Mo-Fr 08:00-18:00" strings', () => {
    expect(hoursFromLd({ openingHours: ['Mo-Fr 08:00-18:00', 'Sa 09:00-12:00'] })![5]).toBe('Saturday: 9:00 AM–12:00 PM');
  });
  it('reads an address out of a directory title', () => {
    expect(addressFromTitle('Opossum Pike Veterinary Clinic, 1550 Opossumtown Pike, Frederick, MD 21702 - MapQuest')).toMatchObject({ address: '1550 Opossumtown Pike, Frederick, MD 21702' });
    expect(addressFromTitle('Best pizza in town')).toBeNull();
  });
  it('jsonLdObjects survives broken JSON', () => {
    expect(jsonLdObjects('<script type="application/ld+json">{not json</script><script type="application/ld+json">{"@type":"Thing"}</script>')).toHaveLength(1);
  });
});
