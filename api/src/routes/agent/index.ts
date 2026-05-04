import Router from 'express';
import * as controller from './controller';
import validate from './validation';
import auth from '../../middlewares/auth';

const router = Router();

router
  .route('/agent')
  .get(auth, validate.sanitizeQuery, controller.list)
  .post(auth, validate.create, controller.create);

router.route('/agent/sync').post(auth, controller.sync);

router.route('/agent/:id(\\d+)/workspace').get(auth, validate.id, controller.workspaceMeta);

router
  .route('/agent/:id(\\d+)/workspace/file/:filename')
  .get(auth, validate.workspaceFilename, controller.getWorkspaceFile)
  .put(auth, validate.workspacePut, controller.putWorkspaceFile);

router
  .route('/agent/:id(\\d+)/workspace/uploads/:filename')
  .get(auth, validate.id, controller.serveWorkspaceUpload);

router
  .route('/agent/:id(\\d+)/skills')
  .get(auth, validate.id, controller.getSkillsConfig)
  .patch(auth, validate.skillsPatch, controller.updateSkillsConfig);

router
  .route('/agent/:id(\\d+)/subagents')
  .get(auth, validate.id, controller.getSubagentsConfig)
  .patch(auth, validate.subagentsPatch, controller.updateSubagentsConfig);

router
  .route('/agent/:id(\\d+)/budget')
  .get(auth, validate.id, controller.getBudget)
  .patch(auth, validate.budgetPatch, controller.updateBudget);

router
  .route('/agent/:id(\\d+)/provider-models')
  .get(auth, validate.id, controller.getProviderModels)
  .patch(auth, validate.providerModelPatch, controller.updateProviderModel);

router.route('/agent/:id(\\d+)/usage').get(auth, validate.id, controller.getUsage);

router
  .route('/agent/:id(\\d+)/limits')
  .get(auth, validate.id, controller.getLimits)
  .patch(auth, validate.limitsPatch, controller.updateLimits);

router
  .route('/agent/:id(\\d+)/conversation/:conversationId(\\d+)/session-settings')
  .get(auth, controller.getSessionSettings)
  .patch(auth, controller.patchSessionSettings);

router
  .route('/agent/:id(\\d+)')
  .get(auth, validate.id, controller.get)
  .patch(auth, validate.update, controller.update)
  .delete(auth, validate.id, controller.destroy);

export default router;
