import { logger } from 'app/logging/logger';
import { parseify } from 'common/util/serialize';
import { controlNetImageProcessed } from 'features/controlNet/store/actions';
import {
  clearPendingControlImages,
  controlNetImageChanged,
  controlNetProcessedImageChanged,
} from 'features/controlNet/store/controlNetSlice';
import { SAVE_IMAGE } from 'features/nodes/util/graphBuilders/constants';
import { addToast } from 'features/system/store/systemSlice';
import { t } from 'i18next';
import { imagesApi } from 'services/api/endpoints/images';
import { queueApi } from 'services/api/endpoints/queue';
import { isImageOutput } from 'services/api/guards';
import { Graph, ImageDTO } from 'services/api/types';
import { socketInvocationComplete } from 'services/events/actions';
import { startAppListening } from '..';

export const addControlNetImageProcessedListener = () => {
  startAppListening({
    actionCreator: controlNetImageProcessed,
    effect: async (action, { dispatch, getState, take }) => {
      const log = logger('session');
      const { controlNetId } = action.payload;
      const controlNet = getState().controlNet.controlNets[controlNetId];

      if (!controlNet?.controlImage) {
        log.error('Unable to process ControlNet image');
        return;
      }

      // ControlNet one-off procressing graph is just the processor node, no edges.
      // Also we need to grab the image.
      const graph: Graph = {
        nodes: {
          [controlNet.processorNode.id]: {
            ...controlNet.processorNode,
            is_intermediate: true,
            image: { image_name: controlNet.controlImage },
          },
          [SAVE_IMAGE]: {
            id: SAVE_IMAGE,
            type: 'save_image',
            is_intermediate: true,
            use_cache: false,
          },
        },
        edges: [
          {
            source: {
              node_id: controlNet.processorNode.id,
              field: 'image',
            },
            destination: {
              node_id: SAVE_IMAGE,
              field: 'image',
            },
          },
        ],
      };
      try {
        const req = dispatch(
          queueApi.endpoints.enqueueGraph.initiate(
            { graph, prepend: true },
            {
              fixedCacheKey: 'enqueueGraph',
            }
          )
        );
        const enqueueResult = await req.unwrap();
        req.reset();
        log.debug(
          { enqueueResult: parseify(enqueueResult) },
          t('queue.graphQueued')
        );

        const [invocationCompleteAction] = await take(
          (action): action is ReturnType<typeof socketInvocationComplete> =>
            socketInvocationComplete.match(action) &&
            action.payload.data.graph_execution_state_id ===
              enqueueResult.queue_item.session_id &&
            action.payload.data.source_node_id === SAVE_IMAGE
        );

        // We still have to check the output type
        if (isImageOutput(invocationCompleteAction.payload.data.result)) {
          const { image_name } =
            invocationCompleteAction.payload.data.result.image;

          // Wait for the ImageDTO to be received
          const [{ payload }] = await take(
            (action) =>
              imagesApi.endpoints.getImageDTO.matchFulfilled(action) &&
              action.payload.image_name === image_name
          );

          const processedControlImage = payload as ImageDTO;

          log.debug(
            { controlNetId: action.payload, processedControlImage },
            'ControlNet image processed'
          );

          // Update the processed image in the store
          dispatch(
            controlNetProcessedImageChanged({
              controlNetId,
              processedControlImage: processedControlImage.image_name,
            })
          );
        }
      } catch (error) {
        log.error({ graph: parseify(graph) }, t('queue.graphFailedToQueue'));

        // handle usage-related errors
        if (error instanceof Object) {
          if ('data' in error && 'status' in error) {
            if (error.status === 403) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const detail = (error.data as any)?.detail || 'Unknown Error';
              dispatch(
                addToast({
                  title: t('queue.graphFailedToQueue'),
                  status: 'error',
                  description: detail,
                  duration: 15000,
                })
              );
              dispatch(clearPendingControlImages());
              dispatch(
                controlNetImageChanged({ controlNetId, controlImage: null })
              );
              return;
            }
          }
        }

        dispatch(
          addToast({
            title: t('queue.graphFailedToQueue'),
            status: 'error',
          })
        );
      }
    },
  });
};
