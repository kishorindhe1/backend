'use strict';

const { v4: uuidv4 } = require('uuid');

const SYMPTOMS = [
  // Cardiology
  { keyword: 'chest pain',      aliases: ['chest tightness','heart pain','angina'],           specs: ['cardiology','general_physician'], emergency: true,  priority: 3 },
  { keyword: 'palpitations',    aliases: ['heart racing','irregular heartbeat'],               specs: ['cardiology'],                     emergency: false, priority: 2 },
  { keyword: 'shortness of breath', aliases: ['breathing difficulty','dyspnea'],             specs: ['cardiology','pulmonology'],        emergency: true,  priority: 3 },

  // Orthopedics
  { keyword: 'knee pain',       aliases: ['knee ache','knee injury','knee swelling'],          specs: ['orthopedics','sports_medicine'],   emergency: false, priority: 2 },
  { keyword: 'back pain',       aliases: ['lower back pain','backache','spine pain'],          specs: ['orthopedics','neurology'],         emergency: false, priority: 2 },
  { keyword: 'joint pain',      aliases: ['arthritis','joint swelling','joint ache'],          specs: ['orthopedics','rheumatology'],      emergency: false, priority: 2 },
  { keyword: 'fracture',        aliases: ['broken bone','bone fracture'],                      specs: ['orthopedics'],                    emergency: true,  priority: 3 },

  // General Physician
  { keyword: 'fever',           aliases: ['high temperature','pyrexia','body temperature'],    specs: ['general_physician','pediatrics'],  emergency: false, priority: 1 },
  { keyword: 'cold',            aliases: ['cough','runny nose','common cold','flu'],           specs: ['general_physician'],              emergency: false, priority: 1 },
  { keyword: 'headache',        aliases: ['head pain','migraine'],                             specs: ['general_physician','neurology'],   emergency: false, priority: 1 },
  { keyword: 'stomach pain',    aliases: ['abdominal pain','stomach ache','belly pain'],       specs: ['general_physician','gastroenterology'], emergency: false, priority: 1 },
  { keyword: 'vomiting',        aliases: ['nausea','throwing up'],                             specs: ['general_physician','gastroenterology'], emergency: false, priority: 1 },
  { keyword: 'diarrhea',        aliases: ['loose motions','loose stools'],                     specs: ['general_physician','gastroenterology'], emergency: false, priority: 1 },
  { keyword: 'weakness',        aliases: ['fatigue','tiredness','body ache'],                  specs: ['general_physician'],              emergency: false, priority: 1 },
  { keyword: 'diabetes',        aliases: ['blood sugar','high sugar','sugar'],                 specs: ['endocrinology','general_physician'], emergency: false, priority: 2 },
  { keyword: 'hypertension',    aliases: ['high blood pressure','bp high'],                    specs: ['cardiology','general_physician'],  emergency: false, priority: 2 },

  // Dermatology
  { keyword: 'skin rash',       aliases: ['rash','skin allergy','itching','hives'],            specs: ['dermatology','general_physician'], emergency: false, priority: 1 },
  { keyword: 'acne',            aliases: ['pimples','skin breakout'],                          specs: ['dermatology'],                    emergency: false, priority: 1 },
  { keyword: 'hair loss',       aliases: ['hair fall','alopecia','balding'],                   specs: ['dermatology','trichology'],       emergency: false, priority: 1 },

  // Gynecology
  { keyword: 'pregnancy',       aliases: ['pregnant','maternity','prenatal'],                  specs: ['gynecology','obstetrics'],         emergency: false, priority: 2 },
  { keyword: 'periods',         aliases: ['menstruation','menstrual pain','irregular periods'], specs: ['gynecology'],                    emergency: false, priority: 2 },

  // Pediatrics
  { keyword: 'child fever',     aliases: ['baby fever','infant fever','kids fever'],           specs: ['pediatrics'],                     emergency: false, priority: 2 },
  { keyword: 'child growth',    aliases: ['baby development','child health','vaccination'],    specs: ['pediatrics'],                     emergency: false, priority: 1 },

  // ENT
  { keyword: 'ear pain',        aliases: ['earache','hearing loss','ear infection'],           specs: ['ent','otolaryngology'],           emergency: false, priority: 1 },
  { keyword: 'sore throat',     aliases: ['throat pain','tonsils','throat infection'],         specs: ['ent','general_physician'],        emergency: false, priority: 1 },
  { keyword: 'sinus',           aliases: ['sinusitis','blocked nose','nasal congestion'],      specs: ['ent'],                            emergency: false, priority: 1 },

  // Ophthalmology
  { keyword: 'eye pain',        aliases: ['eye redness','blurry vision','eye infection'],      specs: ['ophthalmology'],                  emergency: false, priority: 2 },

  // Neurology
  { keyword: 'seizure',         aliases: ['fits','epilepsy','convulsions'],                    specs: ['neurology'],                      emergency: true,  priority: 3 },
  { keyword: 'numbness',        aliases: ['tingling','pins and needles','nerve pain'],         specs: ['neurology','orthopedics'],        emergency: false, priority: 2 },

  // Urology
  { keyword: 'urine problem',   aliases: ['urinary pain','frequent urination','uti'],          specs: ['urology','general_physician'],    emergency: false, priority: 1 },

  // Mental Health
  { keyword: 'depression',      aliases: ['anxiety','mental health','stress','mood'],          specs: ['psychiatry','psychology'],        emergency: false, priority: 2 },
];

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const rows = SYMPTOMS.map(s => ({
      id:               uuidv4(),
      symptom_keyword:  s.keyword,
      symptom_aliases:  `{${s.aliases.map(a => `"${a}"`).join(',')}}`,
      specialisations:  `{${s.specs.map(sp => `"${sp}"`).join(',')}}`,
      is_emergency:     s.emergency,
      priority:         s.priority,
      created_at:       now,
    }));

    await queryInterface.bulkInsert('symptom_specialisation_map', rows);
    console.log(`✅  ${rows.length} symptom mappings seeded`);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('symptom_specialisation_map', null, {});
  },
};
