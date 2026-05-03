import Router from 'express';
import auth from './auth';
import user from './user';
import agent from './agent';
import conversation from './conversation';
import message from './message';
import channel from './channel';
import plugin from './plugin';
import skill from './skill';
import cron from './cron';
import update from './update';
import gateway from './gateway';

const router = Router();

router.use(user);
router.use(agent);
router.use(conversation);
router.use(message);
router.use(channel);
router.use(plugin);
router.use(skill);
router.use(cron);
router.use(auth);
router.use(update);
router.use(gateway);

export default router;
