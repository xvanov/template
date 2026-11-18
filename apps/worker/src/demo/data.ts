/**
 * The demo workspace's content (seed.ts). Fictional company, example.com
 * addresses only. Replace it with your own domain's story: judges remember
 * a demo that looks like a real customer's day.
 */
export const DEMO_ORG = {
  slug: "demo-acme",
  name: "Acme Field Services (demo)",
};

export const DEMO_ITEMS: {
  title: string;
  notes: string | null;
  done: boolean;
}[] = [
  {
    title: "Roof leak at 14 Elm St: fix today",
    notes: "Tenant reports water over the kitchen. Tarp is on; needs a roofer.",
    done: false,
  },
  {
    title: "Boiler service overdue at the Riverside office",
    notes: "Annual service lapsed last month; insurer wants the certificate.",
    done: false,
  },
  {
    title: "Send March invoices",
    notes: "12 invoices; two customers asked for PDF copies.",
    done: false,
  },
  {
    title: "Draft the spring newsletter",
    notes: "Ideas: gutter cleaning offer, new booking page.",
    done: false,
  },
  {
    title: "Replace van tyres before the MOT",
    notes: null,
    done: false,
  },
  {
    title: "Explore a customer review widget",
    notes: "Someday: compare two vendors.",
    done: false,
  },
  {
    title: "Renew the public liability policy",
    notes: "Renewed for 12 months; certificate filed.",
    done: true,
  },
  {
    title: "Onboard the new apprentice",
    notes: "Safety induction done, van keys issued.",
    done: true,
  },
];

export const DEMO_DOC = {
  title: "Acme field service handbook",
  content: `# Acme field service handbook

## Booking and visits

Customers book a visit by phone or on the booking page. We confirm every
booking by email within 2 hours during office hours (08:00 to 18:00,
Monday to Friday).

### Rescheduling

A customer can reschedule free of charge up to 24 hours before the visit.
Later changes cost a 35 USD call-out fee, waived for emergencies.

## Emergencies

A leak, no heating in winter, or exposed wiring is an emergency. The on-call
engineer answers within 30 minutes and aims to be on site within 4 hours.

## Warranty

Labour is guaranteed for 12 months from the visit. Parts carry the
manufacturer's warranty, usually 24 months. A warranty claim needs the job
number from the invoice.

## Payments

Invoices are due within 14 days. We accept bank transfer and card. A second
reminder goes out after 21 days.
`,
};

export const DEMO_INBOX = {
  providerMessageId: "demo-seed-0001",
  fromAddress: "jordan.lee@example.com",
  toAddress: "acme-demo@in.example.com",
  subject: "Can I move Thursday's visit?",
  text: `Hi Acme team,

Something came up at work. Could the boiler visit on Thursday move to
Friday morning instead? Happy to pay the call-out fee if it's too late.

Thanks,
Jordan Lee`,
};
