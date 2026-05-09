/**
 * Seed Mongo with curated catalog properties.
 * Usage: from backend/, `npm run seed`
 */
const { connectDB } = require('../config/db');
const Property = require('../models/Property');
const User = require('../models/User');
const mongoose = require('mongoose');

const img = id => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=70`;

const ALL_AMENITIES = [
  { id: 'a1', name: 'Swimming Pool', iconName: 'water-outline' },
  { id: 'a2', name: 'Gymnasium', iconName: 'barbell-outline' },
  { id: 'a3', name: 'Clubhouse', iconName: 'business-outline' },
  { id: 'a4', name: 'Kids Play Area', iconName: 'happy-outline' },
  { id: 'a5', name: 'Landscaped Garden', iconName: 'leaf-outline' },
  { id: 'a6', name: '24x7 Security', iconName: 'shield-checkmark-outline' },
  { id: 'a7', name: 'Power Backup', iconName: 'flash-outline' },
  { id: 'a8', name: 'Covered Parking', iconName: 'car-outline' },
  { id: 'a9', name: 'Jogging Track', iconName: 'walk-outline' },
  { id: 'a10', name: 'Spa & Sauna', iconName: 'flower-outline' },
  { id: 'a11', name: 'Tennis Court', iconName: 'tennisball-outline' },
  { id: 'a12', name: 'Mini Theatre', iconName: 'film-outline' },
  { id: 'a13', name: 'Concierge', iconName: 'person-outline' },
  { id: 'a14', name: 'EV Charging', iconName: 'battery-charging-outline' },
];

const PROPERTIES = [
  {
    title: 'DLF The Camellias',
    description:
      'Ultra-luxury residential masterpiece offering panoramic views of the Aravalli range.',
    type: 'apartment',
    builder: 'DLF Limited',
    builderInfo: { id: 'b1', name: 'DLF Limited', established: 1946, projectsCompleted: 158, rating: 4.6 },
    city: 'Gurgaon',
    locality: 'Sector 42',
    address: 'Golf Course Road, Sector 42, Gurgaon, Haryana',
    latitude: 28.4595,
    longitude: 77.0876,
    priceMin: 95000000,
    priceMax: 180000000,
    pricePerSqft: 28000,
    configuration: ['4 BHK', '5 BHK', '6 BHK'],
    areaMin: 4200,
    areaMax: 7600,
    totalUnits: 429,
    totalTowers: 9,
    possessionStatus: 'Ready to Move',
    possessionDate: new Date('2024-12-15'),
    reraId: 'HRERA-GGM-330-2024',
    images: ['photo-1545324418-cc1a3fa10c00', 'photo-1582268611958-ebfd161ef9cf', 'photo-1560448204-e02f11c3d0e2'].map(img),
    amenities: ALL_AMENITIES.slice(0, 12),
    floorPlans: [],
    highlights: ['Golf course views', 'Private lift lobby', 'Smart home automation'],
    featured: true,
    trending: true,
    rating: 4.8,
    reviewCount: 218,
  },
  {
    title: 'Lodha World One',
    description:
      "Mumbai's iconic supertall residential tower offering 360° city and sea views.",
    type: 'penthouse',
    builder: 'Lodha Group',
    builderInfo: { id: 'b3', name: 'Lodha Group', established: 1980, projectsCompleted: 84, rating: 4.4 },
    city: 'Mumbai',
    locality: 'Lower Parel',
    address: 'Senapati Bapat Marg, Lower Parel, Mumbai',
    latitude: 19.0144,
    longitude: 72.825,
    priceMin: 75000000,
    priceMax: 250000000,
    pricePerSqft: 38000,
    configuration: ['3 BHK', '4 BHK', '5 BHK'],
    areaMin: 1980,
    areaMax: 6500,
    totalUnits: 290,
    totalTowers: 1,
    possessionStatus: 'Ready to Move',
    possessionDate: new Date('2023-08-10'),
    reraId: 'P51900000118',
    images: ['photo-1564013799919-ab600027ffc6', 'photo-1568605114967-8130f3a36994'].map(img),
    amenities: ALL_AMENITIES.slice(2, 14),
    floorPlans: [],
    highlights: ['117 floors', 'Sea views', 'Designer interiors'],
    featured: true,
    trending: true,
    rating: 4.7,
    reviewCount: 192,
  },
  {
    title: 'Godrej Reserve',
    description: 'Plotted development surrounded by 100+ acres of forest. Premium villa plots.',
    type: 'plot',
    builder: 'Godrej Properties',
    builderInfo: { id: 'b2', name: 'Godrej Properties', established: 1990, projectsCompleted: 96, rating: 4.5 },
    city: 'Bangalore',
    locality: 'Devanahalli',
    address: 'NH-44, Devanahalli, Bangalore',
    latitude: 13.2517,
    longitude: 77.7186,
    priceMin: 12500000,
    priceMax: 38000000,
    pricePerSqft: 11500,
    configuration: ['Plot 1200', 'Plot 2400', 'Plot 3600'],
    areaMin: 1200,
    areaMax: 3600,
    totalUnits: 712,
    possessionStatus: 'Under Construction',
    possessionDate: new Date('2026-06-30'),
    reraId: 'PRM/KA/RERA/1251/446/PR/220317/004812',
    images: ['photo-1512917774080-9991f1c4c750', 'photo-1493663284031-b7e3aefcae8e'].map(img),
    amenities: ALL_AMENITIES.slice(4, 14),
    floorPlans: [],
    highlights: ['Near airport', 'Forest views', 'Investment grade'],
    featured: false,
    trending: true,
    rating: 4.5,
    reviewCount: 156,
  },
  {
    title: 'Prestige Lakeside Habitat',
    description:
      'Disney-themed lakefront villas and apartments spread over 102 acres beside Varthur Lake.',
    type: 'villa',
    builder: 'Prestige Group',
    builderInfo: { id: 'b4', name: 'Prestige Group', established: 1986, projectsCompleted: 254, rating: 4.7 },
    city: 'Bangalore',
    locality: 'Varthur',
    address: 'Whitefield - Sarjapur Road, Varthur, Bangalore',
    latitude: 12.9352,
    longitude: 77.7376,
    priceMin: 22500000,
    priceMax: 95000000,
    pricePerSqft: 9800,
    configuration: ['3 BHK', '4 BHK', '5 BHK Villa'],
    areaMin: 2300,
    areaMax: 9700,
    totalUnits: 3247,
    totalTowers: 35,
    possessionStatus: 'Ready to Move',
    possessionDate: new Date('2023-12-30'),
    reraId: 'PRM/KA/RERA/1251/310/PR/171015/000414',
    images: ['photo-1600607687939-ce8a6c25118c', 'photo-1600573472550-8090b5e0745e'].map(img),
    amenities: ALL_AMENITIES.slice(0, 14),
    floorPlans: [],
    highlights: ['Lakefront views', 'Themed clubhouses', '4 km jogging track'],
    featured: true,
    trending: true,
    rating: 4.6,
    reviewCount: 412,
  },
  {
    title: 'M3M Golf Estate',
    description: 'Resort-style residences overlooking a 9-hole golf course.',
    type: 'apartment',
    builder: 'M3M India',
    builderInfo: { id: 'b6', name: 'M3M India', established: 2007, projectsCompleted: 38, rating: 4.3 },
    city: 'Gurgaon',
    locality: 'Sector 65',
    priceMin: 28500000,
    priceMax: 95000000,
    pricePerSqft: 16500,
    configuration: ['3 BHK', '4 BHK', '5 BHK'],
    areaMin: 1750,
    areaMax: 5800,
    totalUnits: 944,
    totalTowers: 12,
    possessionStatus: 'Ready to Move',
    possessionDate: new Date('2022-03-30'),
    reraId: 'HRERA-PKL-2018-1024',
    images: ['photo-1613490493576-7fde63acd811', 'photo-1600596542815-ffad4c1539a9'].map(img),
    amenities: ALL_AMENITIES.slice(1, 13),
    floorPlans: [],
    highlights: ['Golf views', 'Italian marble', 'Sky deck'],
    featured: false,
    trending: true,
    rating: 4.4,
    reviewCount: 268,
  },
  {
    title: 'Sobha Royal Pavilion',
    description: 'Aristocratic homes inspired by classical British architecture.',
    type: 'apartment',
    builder: 'Sobha Limited',
    builderInfo: { id: 'b7', name: 'Sobha Limited', established: 1995, projectsCompleted: 145, rating: 4.6 },
    city: 'Bangalore',
    locality: 'Sarjapur Road',
    priceMin: 13500000,
    priceMax: 42500000,
    pricePerSqft: 8900,
    configuration: ['2 BHK', '3 BHK', '4 BHK'],
    areaMin: 1419,
    areaMax: 4226,
    totalUnits: 1032,
    totalTowers: 14,
    possessionStatus: 'Under Construction',
    possessionDate: new Date('2026-12-30'),
    reraId: 'PRM/KA/RERA/1251/308/PR/180614/001818',
    images: ['photo-1582268611958-ebfd161ef9cf', 'photo-1502672023488-70e25813eb80'].map(img),
    amenities: ALL_AMENITIES.slice(2, 12),
    floorPlans: [],
    highlights: ['Royal architecture', '36 acres', 'Sobha quality'],
    featured: true,
    trending: false,
    rating: 4.5,
    reviewCount: 184,
  },
];

(async () => {
  try {
    await connectDB();
    console.log('[seed] Clearing existing seeded properties (isUserListing=false)...');
    await Property.deleteMany({ isUserListing: { $ne: true } });
    console.log('[seed] Inserting curated catalog...');
    await Property.insertMany(PROPERTIES.map(p => ({ ...p, isUserListing: false, status: 'live' })));

    // Create demo user (consumer + seller hybrid)
    let user = await User.findOne({ email: 'demo@aabroo.com' });
    if (!user) {
      user = new User({
        fullName: 'Saurabh Singh',
        email: 'demo@aabroo.com',
        phone: '9876543210',
        avatar: 'https://i.pravatar.cc/300?img=12',
        city: 'Gurgaon',
        role: 'consumer',
        seller: { plan: 'free', listingQuotaUsed: 0, listingQuotaTotal: 1, totalLeads: 0, rating: 0 },
      });
      await user.setPassword('Aabroo@123');
      await user.save();
      console.log('[seed] Demo user created: demo@aabroo.com / Aabroo@123');
    }

    console.log('[seed] Done.');
  } catch (e) {
    console.error('[seed] Failed:', e);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
})();
