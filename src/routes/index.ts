import { Router, Request, Response } from 'express';
import { DoctorProfile, Hospital, DoctorReview } from '../models';
import { VerificationStatus } from '../models/doctor.model';
import authRoutes          from '../modules/auth/auth.routes';
import patientRoutes       from '../modules/patients/patient.routes';
import hospitalRoutes      from '../modules/hospitals/hospital.routes';
import doctorRoutes        from '../modules/doctors/doctor.routes';
import appointmentRoutes   from '../modules/appointments/appointment.routes';
import paymentRoutes       from '../modules/payments/payment.routes';
import scheduleRoutes      from '../modules/schedules/schedule.routes';
import queueRoutes         from '../modules/queue/queue.routes';
import receptionistRoutes  from '../modules/receptionist/receptionist.routes';
import notificationRoutes  from '../modules/notifications/notification.routes';
import opdRoutes           from '../modules/opd/opd.routes';
import searchRoutes        from '../modules/search/search.routes';
import adminRoutes         from '../modules/admin/admin.routes';
import adminAuthRoutes     from '../modules/admin-auth/admin-auth.routes';
import reviewRoutes        from '../modules/reviews/review.routes';

const router = Router();

// ── Public platform stats (hero card on home screen) ─────────────────────────
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [totalDoctors, totalHospitals, ratingRow] = await Promise.all([
      DoctorProfile.count({ where: { verification_status: VerificationStatus.APPROVED, is_active: true } }),
      Hospital.count({ where: { onboarding_status: 'live' } }),
      DoctorReview.findOne({
        attributes: [[DoctorReview.sequelize!.fn('AVG', DoctorReview.sequelize!.col('rating')), 'avg_rating']],
        raw: true,
      }),
    ]);
    const avgRating = parseFloat((ratingRow as any)?.avg_rating ?? '0') || 0;
    res.json({
      success: true,
      data: {
        total_doctors:   totalDoctors,
        total_hospitals: totalHospitals,
        avg_rating:      Math.round(avgRating * 10) / 10,
      },
    });
  } catch {
    res.json({ success: true, data: { total_doctors: 0, total_hospitals: 0, avg_rating: 0 } });
  }
});

router.get('/health', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      status: 'healthy', version: '4.0.0',
      phase:  'Phase 4 — Search, Admin, Cron, Bug Fixes',
      uptime: Math.floor(process.uptime()), timestamp: new Date().toISOString(),
    },
  });
});

// ── Phase 1 + 2 ───────────────────────────────────────────────────────────────
router.use('/auth',          authRoutes);
router.use('/patients',      patientRoutes);
router.use('/hospitals',     hospitalRoutes);
router.use('/doctors',       doctorRoutes);
router.use('/appointments',  appointmentRoutes);
router.use('/payments',      paymentRoutes);
router.use('/schedules',     scheduleRoutes);

// ── Phase 3 ───────────────────────────────────────────────────────────────────
router.use('/queue',         queueRoutes);
router.use('/receptionist',  receptionistRoutes);
router.use('/notifications', notificationRoutes);
router.use('/opd',           opdRoutes);

// ── Phase 4 ───────────────────────────────────────────────────────────────────
router.use('/search',        searchRoutes);
router.use('/admin/auth',    adminAuthRoutes);   // must be before /admin (no auth required)
router.use('/admin',         adminRoutes);

// ── Phase 5 ───────────────────────────────────────────────────────────────────
router.use('/reviews',       reviewRoutes);

export default router;
