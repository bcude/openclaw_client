import Router from 'express';
import * as controller from './controller';

const router = Router();

router.route('/gateway/status').get(controller.status);

export default router;
