import { Op, QueryTypes } from 'sequelize';
import { sequelize }        from '../../config/database';
import { redis }            from '../../config/redis';
import {
  DoctorSearchIndex,
  DoctorProfile, VerificationStatus,
  DoctorHospitalAffiliation,
  Hospital, OnboardingStatus,
  GeneratedSlot, SlotStatus,
  SymptomSpecialisationMap,
}                           from '../../models';
import { ServiceResponse, ok } from '../../types';
import { logger }              from '../../utils/logger';

// ── Cache TTLs ────────────────────────────────────────────────────────────────
const TTL = {
  AUTOCOMPLETE:  5  * 60,   // 5 min
  SEARCH_RESULT: 2  * 60,   // 2 min — short because slot counts change fast
  DOCTOR_CARD:   10 * 60,   // 10 min
} as const;

// ── Wilson score lower bound ──────────────────────────────────────────────────
// Prevents a 5-star doctor with 2 reviews outranking a 4.7-star with 500 reviews
function wilsonScore(avgRating: number, totalReviews: number): number {
  if (totalReviews === 0) return 0;
  const p = avgRating / 5;
  const n = totalReviews;
  const z = 1.96; // 95% confidence
  const numerator   = p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  const denominator = 1 + (z * z) / n;
  return Math.max(0, Math.min(1, numerator / denominator));
}

// ── Ranking score ─────────────────────────────────────────────────────────────
function rankingScore(entry: DoctorSearchIndex, distanceKm?: number): number {
  // Availability score
  let availScore = 0.1;
  if (entry.available_today) {
    if (entry.available_slots_today >= 10) availScore = 0.8;
    else if (entry.available_slots_today >= 5) availScore = 0.6;
    else if (entry.available_slots_today >= 1) availScore = 0.4;
  }
  if (entry.next_available_slot) {
    const hoursAway = (entry.next_available_slot.getTime() - Date.now()) / 3_600_000;
    if (hoursAway <= 2) availScore = 1.0;
    else if (hoursAway <= 24) availScore = Math.max(availScore, 0.8);
  }

  // Distance score
  let distScore = 0.5;
  if (distanceKm !== undefined) {
    distScore = Math.max(0, 1 - distanceKm / 35);
  }

  return (
    0.25 * availScore +
    0.20 * (Number(entry.reliability_score) / 100) +
    0.15 * Number(entry.wilson_rating_score) +
    0.10 * distScore
  );
}

// ── Rebuild index for one doctor+hospital pair ────────────────────────────────
export async function rebuildDoctorIndex(doctorId: string, hospitalId: string): Promise<void> {
  const doctor = await DoctorProfile.findByPk(doctorId);
  const affil  = await DoctorHospitalAffiliation.findOne({
    where: { doctor_id: doctorId, hospital_id: hospitalId, is_active: true },
  });
  const hospital = await Hospital.findByPk(hospitalId);

  if (!doctor || !affil || !hospital) return;

  const today    = new Date().toISOString().split('T')[0];
  const todayStart = new Date(`${today}T00:00:00.000Z`);
  const todayEnd   = new Date(`${today}T23:59:59.999Z`);

  const slotsToday = await GeneratedSlot.count({
    where: {
      doctor_id: doctorId, hospital_id: hospitalId,
      status: SlotStatus.AVAILABLE,
      slot_datetime: { [Op.between]: [todayStart, todayEnd] },
    },
  });

  const nextSlot = await GeneratedSlot.findOne({
    where: {
      doctor_id: doctorId, hospital_id: hospitalId,
      status: SlotStatus.AVAILABLE,
      slot_datetime: { [Op.gt]: new Date() },
    },
    order: [['slot_datetime', 'ASC']],
  });

  const normalized = doctor.full_name
    .toLowerCase()
    .replace(/^dr\.?\s*/i, '')
    .trim();

  const wilson = wilsonScore(Number(doctor.reliability_score), 0); // will use real reviews in Phase 5

  const [entry, created] = await DoctorSearchIndex.findOrCreate({
    where: { doctor_id: doctorId, hospital_id: hospitalId },
    defaults: {
      doctor_id: doctorId, hospital_id: hospitalId,
      doctor_name:            doctor.full_name,
      doctor_name_normalized: normalized,
      specialization:         doctor.specialization,
      qualifications:         doctor.qualifications,
      languages_spoken:       doctor.languages_spoken,
      gender:                 doctor.gender,
      experience_years:       doctor.experience_years,
      hospital_name:          hospital.name,
      city:                   hospital.city,
      area:                   hospital.address_line1,
      latitude:               hospital.latitude ? Number(hospital.latitude) : null,
      longitude:              hospital.longitude ? Number(hospital.longitude) : null,
      consultation_fee:       Number(affil.consultation_fee),
      next_available_slot:    nextSlot?.slot_datetime ?? null,
      available_today:        slotsToday > 0,
      available_slots_today:  slotsToday,
      avg_rating:             0,
      total_reviews:          0,
      wilson_rating_score:    wilson,
      reliability_score:      Number(doctor.reliability_score),
      total_consultations:    0,
      is_active:              doctor.is_active && !doctor.deleted_at,
      is_verified:            doctor.verification_status === VerificationStatus.APPROVED,
      hospital_is_live:       hospital.onboarding_status === OnboardingStatus.LIVE,
      last_indexed_at:        new Date(),
    },
  });

  if (!created) {
    await entry.update({
      doctor_name:            doctor.full_name,
      doctor_name_normalized: normalized,
      specialization:         doctor.specialization,
      consultation_fee:       Number(affil.consultation_fee),
      next_available_slot:    nextSlot?.slot_datetime ?? null,
      available_today:        slotsToday > 0,
      available_slots_today:  slotsToday,
      wilson_rating_score:    wilson,
      reliability_score:      Number(doctor.reliability_score),
      is_active:              doctor.is_active && !doctor.deleted_at,
      is_verified:            doctor.verification_status === VerificationStatus.APPROVED,
      hospital_is_live:       hospital.onboarding_status === OnboardingStatus.LIVE,
      last_indexed_at:        new Date(),
    });
  }

  // Invalidate doctor card cache
  await redis.del(`search:doctor:${doctorId}:${hospitalId}`);
  logger.debug('Search index rebuilt', { doctorId, hospitalId });
}

// ── Rebuild entire index ──────────────────────────────────────────────────────
export async function rebuildFullIndex(): Promise<{ updated: number; errors: number }> {
  const affiliations = await DoctorHospitalAffiliation.findAll({ where: { is_active: true } });
  let updated = 0, errors = 0;

  for (const aff of affiliations) {
    try {
      await rebuildDoctorIndex(aff.doctor_id, aff.hospital_id);
      updated++;
    } catch (err) {
      errors++;
      logger.error('Index rebuild error', { doctorId: aff.doctor_id, err });
    }
  }

  logger.info('Full search index rebuilt', { updated, errors });
  return { updated, errors };
}

// ── Symptom → specialisation mapping ─────────────────────────────────────────
async function mapSymptomsToSpecialisations(query: string): Promise<string[]> {
  const words   = query.toLowerCase().split(/\s+/);
  const results = await SymptomSpecialisationMap.findAll({
    where: {
      [Op.or]: [
        { symptom_keyword: { [Op.in]: words } },
        sequelize.literal(`symptom_aliases && ARRAY[${words.map(w => `'${w.replace(/'/g, "''")}'`).join(',')}]::varchar[]`),
      ],
    },
    order: [['priority', 'DESC']],
  });

  const specialisations = new Set<string>();
  results.forEach(r => r.specialisations.forEach(s => specialisations.add(s)));
  return [...specialisations];
}

// ── Autocomplete ──────────────────────────────────────────────────────────────
export interface AutocompleteResult {
  type:      'doctor' | 'specialisation';
  display:   string;
  sub:       string;
  doctor_id?: string;
  query?:    string;
}

export async function autocomplete(q: string, city?: string): Promise<ServiceResponse<AutocompleteResult[]>> {
  const normalized = q.toLowerCase().replace(/^dr\.?\s*/i, '').trim();
  if (normalized.length < 2) return ok([]);

  const cacheKey = `search:autocomplete:${normalized}:${city ?? ''}`;
  let cached: string | null = null;
  try { cached = await redis.get(cacheKey); } catch { /* Redis unavailable — skip cache */ }
  if (cached) return ok(JSON.parse(cached));

  const where: Record<string, unknown> = {
    is_active: true, is_verified: true, hospital_is_live: true,
    doctor_name_normalized: { [Op.iLike]: `%${normalized}%` },
  };
  if (city) where.city = { [Op.iLike]: `%${city}%` };

  const doctors = await DoctorSearchIndex.findAll({
    where, attributes: ['doctor_id', 'doctor_name', 'specialization', 'hospital_name', 'city'],
    order: [['wilson_rating_score', 'DESC']], limit: 5,
  });

  const results: AutocompleteResult[] = doctors.map(d => ({
    type:      'doctor' as const,
    display:   d.doctor_name,
    sub:       `${d.specialization} · ${d.hospital_name}`,
    doctor_id: d.doctor_id,
  }));

  // Add matching specialisations
  const specs = await DoctorSearchIndex.findAll({
    where: {
      is_active: true, is_verified: true, hospital_is_live: true,
      specialization: { [Op.iLike]: `%${normalized}%` },
      ...(city && { city: { [Op.iLike]: `%${city}%` } }),
    },
    attributes: ['specialization', 'city'],
    group: ['specialization', 'city'],
    limit: 2,
  });

  specs.forEach(s => {
    results.push({
      type:    'specialisation',
      display: s.specialization.charAt(0).toUpperCase() + s.specialization.slice(1),
      sub:     `Doctors in ${s.city}`,
      query:   `specialization=${encodeURIComponent(s.specialization)}&city=${encodeURIComponent(s.city)}`,
    });
  });

  try { await redis.setex(cacheKey, TTL.AUTOCOMPLETE, JSON.stringify(results)); } catch { /* skip */ }
  return ok(results);
}

// ── Smart search ──────────────────────────────────────────────────────────────
export interface SearchFilters {
  q?:              string;
  specialization?: string;
  city?:           string;
  date?:           string;
  gender?:         string;
  language?:       string;
  min_rating?:     number;
  max_fee?:        number;
  min_experience?: number;
  available_today?: boolean;
  hospital_id?:    string;
  lat?:            number;
  lng?:            number;
  sort?:           'relevance' | 'distance' | 'rating' | 'fee_asc' | 'fee_desc' | 'availability' | 'reliability';
  page:            number;
  per_page:        number;
}

export interface SearchResult {
  doctor_id:        string;
  hospital_id:      string;
  name:             string;
  specialization:   string;
  qualifications:   string[];
  experience_years: number;
  languages:        string[];
  gender:           string | null;
  consultation_fee: number;
  hospital: { name: string; city: string; area: string | null };
  availability: {
    next_slot:            Date | null;
    slots_today:          number;
    available_today:      boolean;
    urgency:              string | null;
  };
  ratings: { avg: number; count: number; wilson: number };
  reliability: { score: number; label: string };
  badges:   string[];
  distance_km?: number;
  ranking_score: number;
}

export async function searchDoctors(filters: SearchFilters): Promise<ServiceResponse<{ results: SearchResult[]; total: number; query_interpretation: object }>> {
  const { page, per_page } = filters;
  const cacheKey = `search:results:${JSON.stringify(filters)}`;
  let cached: string | null = null;
  try { cached = await redis.get(cacheKey); } catch { /* Redis unavailable — skip cache */ }
  if (cached) return ok(JSON.parse(cached));

  // Detect symptom query and map to specialisations
  let mappedSpecs: string[] = [];
  let detectedSymptoms: string[] = [];

  if (filters.q && !filters.specialization) {
    mappedSpecs = await mapSymptomsToSpecialisations(filters.q);
    if (mappedSpecs.length > 0) detectedSymptoms = [filters.q];
  }

  // Build WHERE clause
  const where: Record<string, unknown> = {
    is_active: true, is_verified: true, hospital_is_live: true,
  };

  if (filters.specialization) {
    where.specialization = { [Op.iLike]: `%${filters.specialization}%` };
  } else if (mappedSpecs.length > 0) {
    where.specialization = { [Op.in]: mappedSpecs };
  }

  if (filters.city)       where.city              = { [Op.iLike]: `%${filters.city}%` };
  if (filters.hospital_id)where.hospital_id        = filters.hospital_id;
  if (filters.gender)     where.gender             = filters.gender;
  if (filters.max_fee)    where.consultation_fee   = { [Op.lte]: filters.max_fee };
  if (filters.min_experience) where.experience_years = { [Op.gte]: filters.min_experience };
  if (filters.available_today) where.available_today = true;
  if (filters.min_rating) where.avg_rating         = { [Op.gte]: filters.min_rating };
  if (filters.language) {
    where[Op.and as unknown as string] = sequelize.literal(
      `'${filters.language}' = ANY(languages_spoken)`
    );
  }

  // Full text doctor name search
  if (filters.q && mappedSpecs.length === 0) {
    const normalized = filters.q.toLowerCase().replace(/^dr\.?\s*/i, '').trim();
    where.doctor_name_normalized = { [Op.iLike]: `%${normalized}%` };
  }

  let order: [string, string][] = [['wilson_rating_score', 'DESC']];
  if (filters.sort === 'fee_asc')     order = [['consultation_fee', 'ASC']];
  if (filters.sort === 'fee_desc')    order = [['consultation_fee', 'DESC']];
  if (filters.sort === 'reliability') order = [['reliability_score', 'DESC']];
  if (filters.sort === 'rating')      order = [['wilson_rating_score', 'DESC']];
  if (filters.sort === 'availability')order = [['available_slots_today', 'DESC']];

  const { rows, count } = await DoctorSearchIndex.findAndCountAll({
    where,
    order,
    limit:  per_page,
    offset: (page - 1) * per_page,
  });

  // Build results with distance if lat/lng provided
  const results: SearchResult[] = rows.map(entry => {
    let distanceKm: number | undefined;
    if (filters.lat && filters.lng && entry.latitude && entry.longitude) {
      distanceKm = haversineKm(filters.lat, filters.lng, Number(entry.latitude), Number(entry.longitude));
    }

    const score = rankingScore(entry, distanceKm);
    const reliabilityLabel = Number(entry.reliability_score) >= 90 ? 'Highly Reliable'
      : Number(entry.reliability_score) >= 75 ? 'Reliable'
      : Number(entry.reliability_score) >= 60 ? 'Needs Improvement' : 'Under Review';

    const badges: string[] = [];
    if (Number(entry.reliability_score) >= 90)   badges.push('highly_reliable');
    if (Number(entry.wilson_rating_score) >= 0.85) badges.push('top_rated');
    if (entry.experience_years >= 10)             badges.push('experienced');

    let urgency: string | null = null;
    if (entry.available_slots_today > 0 && entry.available_slots_today <= 3) urgency = `Only ${entry.available_slots_today} slots left!`;

    return {
      doctor_id:        entry.doctor_id,
      hospital_id:      entry.hospital_id,
      name:             entry.doctor_name,
      profile_photo_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(entry.doctor_name)}&background=4F46E5&color=fff&size=200&bold=true&rounded=true`,
      specialization:   entry.specialization,
      qualifications:   entry.qualifications,
      experience_years: entry.experience_years,
      languages:        entry.languages_spoken,
      gender:           entry.gender,
      consultation_fee: Number(entry.consultation_fee),
      hospital: { name: entry.hospital_name, city: entry.city, area: entry.area },
      availability: {
        next_slot:       entry.next_available_slot,
        slots_today:     entry.available_slots_today,
        available_today: entry.available_today,
        urgency,
      },
      ratings: {
        avg:    Number(entry.avg_rating),
        count:  entry.total_reviews,
        wilson: Number(entry.wilson_rating_score),
      },
      reliability: { score: Number(entry.reliability_score), label: reliabilityLabel },
      badges,
      ...(distanceKm !== undefined && { distance_km: Math.round(distanceKm * 10) / 10 }),
      ranking_score: Math.round(score * 1000) / 1000,
    };
  });

  // Sort by ranking score if sort=relevance (default)
  if (!filters.sort || filters.sort === 'relevance' || filters.sort === 'distance') {
    results.sort((a, b) => b.ranking_score - a.ranking_score);
  }

  const queryInterpretation = {
    original_query:        filters.q ?? null,
    detected_symptoms:     detectedSymptoms,
    mapped_specialisations:mappedSpecs,
    detected_location:     filters.city ?? null,
    applied_filters:       Object.keys(filters).filter(k => !['page','per_page','q'].includes(k) && filters[k as keyof SearchFilters]),
  };

  const response = { results, total: count, query_interpretation: queryInterpretation };
  try { await redis.setex(cacheKey, TTL.SEARCH_RESULT, JSON.stringify(response)); } catch { /* skip */ }
  return ok(response);
}

// ── Haversine distance ────────────────────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R   = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
