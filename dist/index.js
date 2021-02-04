module.exports =
/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 866:
/***/ ((module) => {

/**
 * Contains functions useful for working with CloudWatchEvents + ECS tasks
 */

/*
 * Rule object:
 * {
 *     Name: 'Demo',
 *     Arn: 'arn:aws:events:us-east-1:00000000001:rule/Demo',
 *     State: 'DISABLED',
 *     Description: 'Demo to see how well this works',
 *     ScheduleExpression: 'rate(1 minute)',
 *     EventBusName: 'default'
 * },
 *
 * Target object:
 * {
 *   Id: 'Demo-Scheduled-Task',
 *   Arn: 'arn:aws:ecs:<REGION>:<ACCOUNT ID>:cluster/<CLUSTER NAME>',
 *   RoleArn: 'arn:aws:iam::<ACCOUNT ID>:role/ecsEventsRole',
 *   Input: '{"containerOverrides":[{"name":"Demo","command":["sleep"," 50"]}]}',
 *   EcsParameters: {
 *     TaskDefinitionArn:
 *     'arn:aws:ecs:<REGION>:<ACCOUNT ID>:task-definition/Demo:<VERSION>',
 *     TaskCount: 1,
 *     LaunchType: 'EC2'
 *   }
 * }
 */

/**
 * Strips all information after the task-definition/<name> bits out of
 * the given ARN. Needed so we can find related task ARNs. Designed so
 * that any extention of the Task definition ARN will not break this
 * logic.
 */
function simplifyTaskDefinitionArn(arn) {
  // arn:aws:ecs:<REGION>:<ACCOUNT ID>:task-definition/<task-family-name>:<VERSION>
  const splitArn = arn.split(':');
  if (splitArn.length < 6 || !splitArn[5].startsWith('task-definition/'))
    throw new Error(`Not task-definition ARN: ${arn}`);

  // Cut it down to only the fields we care about; discard the rest.
  splitArn.length = 6;
  return splitArn.join(':');
}

/**
 * Given an array of Cloud Watch Event targets and an ECS cluster name,
 * this function will filter out any targets that are not part of the
 * ECS cluster of the given name.
 * @param {[CloudWatchEventTargets]} targets - The targets from
 * listTargetsByRule
 * @param {string} clusterName - Name of the cluster to filter on.
 * @return {[CloudWatchEventTargets]} All targets associated with the
 * cluster.
 */
function filterNonEcsClusterTargets(targets, clusterName) {
  // arn:aws:ecs:<REGION>:<ACCOUNT ID>:cluster/<CLUSTER NAME>
  const arnClusterName = `cluster/${clusterName}`;
  return targets.filter((target) => {
    const splitArn = target.Arn.split(':');
    return splitArn[2] === 'ecs' && splitArn[5] === arnClusterName;
  });
}

/**
 * Given an array of Cloud Watch Event targets and a new task
 * definition ARN, this function will filter out any targets that have
 * no association with the provided task definition ARN. In effect
 * this keeps all targets with an older version of the given task
 * definition ARN.
 * @param {[CloudWatchEventTargets]} targets - The targets to filter
 * @param {string} newTaskDefArn - The full new task ARN.
 * @return {[CloudWatchEventTargets]} All targets associated with the
 * ARN (all previous versions of this task)
 */
function filterUnrelatedTaskDefTargets(targets, newTaskDefArn) {
  const newTaskDefArnSimple = simplifyTaskDefinitionArn(newTaskDefArn);
  return targets.filter((target) => {
    const arn = target.EcsParameters.TaskDefinitionArn;
    const taskDefArnSimple = simplifyTaskDefinitionArn(arn);
    return taskDefArnSimple === newTaskDefArnSimple;
  });
}

module.exports = {
  filterNonEcsClusterTargets,
  filterUnrelatedTaskDefTargets,
};


/***/ }),

/***/ 865:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

const aws = __nccwpck_require__(63);
const core = __nccwpck_require__(895);
const ecsCwe = __nccwpck_require__(866);
const fs = __nccwpck_require__(747);
const path = __nccwpck_require__(622);
const yaml = __nccwpck_require__(21);

// Attributes that are returned by DescribeTaskDefinition, but are not valid RegisterTaskDefinition inputs
const IGNORED_TASK_DEFINITION_ATTRIBUTES = [
  'compatibilities',
  'taskDefinitionArn',
  'requiresAttributes',
  'revision',
  'status',
  'registeredAt',
  'deregisteredAt',
  'registeredBy'
];

function isEmptyValue(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  if (Array.isArray(value) && value.length === 0) {
    return true;
  }

  if (typeof value === 'object' && Object.values(value).length === 0) {
    return true;
  }

  return false;
}

function emptyValueReplacer(_, value) {
  if (isEmptyValue(value)) {
    return undefined;
  }

  if (typeof value === 'object') {
    for (const childValue of Object.values(value)) {
      if (!isEmptyValue(childValue)) {
        // the object has at least one non-empty property
        return value;
      }
    }
    // the object has no non-empty property
    return undefined;
  }

  return value;
}

function cleanNullKeys(obj) {
  return JSON.parse(JSON.stringify(obj, emptyValueReplacer));
}

function removeIgnoredAttributes(taskDef) {
  for (const attribute of IGNORED_TASK_DEFINITION_ATTRIBUTES) {
    if (taskDef[attribute]) {
      core.warning(
        `Ignoring property '${attribute}' in the task definition file. ` +
          'This property is returned by the Amazon ECS DescribeTaskDefinition API and may be shown in the ECS console, ' +
          'but it is not a valid field when registering a new task definition. ' +
          'This field can be safely removed from your task definition file.'
      );
      delete taskDef[attribute];
    }
  }

  return taskDef;
}

/*
 * Target object:
 * {
 *   Id: 'Alpine-Cron-Demo-Scheduled-Task',
 *   Arn: 'arn:aws:ecs:<REGION>:<ACCOUNT ID>:cluster/<CLUSTER NAME>',
 *   RoleArn: 'arn:aws:iam::<ACCOUNT ID>:role/ecsEventsRole',
 *   Input: '{"containerOverrides":[{"name":"Alpine-Demo","command":["sleep"," 50"]}]}',
 *   EcsParameters: {
 *     TaskDefinitionArn:
 *     'arn:aws:ecs:<REGION>:<ACCOUNT ID>:task-definition/Alpine-Cron-Demo:<VERSION>',
 *     TaskCount: 1,
 *     LaunchType: 'EC2'
 *   }
 * }
 */

async function processCloudwatchEventRule(
  cwe,
  rule,
  clusterName,
  newTaskDefArn
) {
  const ruleName = rule.Name;
  core.debug(`Looking up Targets for rule ${ruleName}`);

  const data = await cwe
    .listTargetsByRule({
      Rule: ruleName,
    })
    .promise();
  const ruleTargets = data && data.Targets;
  core.debug(`Rule targets for ${ruleName}: ${JSON.stringify(ruleTargets)}`);

  if (!ruleTargets || !ruleTargets.length) return null;

  // Return all targets that are relevant to this cluster.
  const ecsClusterTargets = ecsCwe.filterNonEcsClusterTargets(
    ruleTargets,
    clusterName
  );
  core.debug(
    `ECS ${clusterName} targets for ${ruleName}: ${JSON.stringify(
      ecsClusterTargets
    )}`
  );

  // Of the relevant targets, find the ones whose ARN task matches new ARN (minus version)
  const ecsClusterTaskTargets = ecsCwe.filterUnrelatedTaskDefTargets(
    ecsClusterTargets,
    newTaskDefArn
  );
  core.debug(
    `Task targets for ${ruleName}: ${JSON.stringify(ecsClusterTaskTargets)}`
  );

  // Bail if nothing to update.
  if (!ecsClusterTaskTargets.length) return null;

  // Now we just have to update all the targets that survived.
  const updatedTargets = ecsClusterTaskTargets.map((target) => {
    target.EcsParameters.TaskDefinitionArn = newTaskDefArn;
    return target;
  });
  core.debug(
    `Updated targets for ${ruleName}: ${JSON.stringify(updatedTargets)}`
  );

  return cwe
    .putTargets({
      Rule: ruleName,
      Targets: updatedTargets,
    })
    .promise();
}

async function run() {
  try {
    const awsCommonOptions = {
      customUserAgent: 'amazon-ecs-deploy-task-definition-for-github-actions',
    };

    const ecs = new aws.ECS(awsCommonOptions);
    const cwe = new aws.CloudWatchEvents(awsCommonOptions);

    // Get inputs
    const taskDefinitionFile = core.getInput('task-definition', {
      required: true,
    });
    const cluster = core.getInput('cluster', { required: false }) || 'default';
    const rulePrefix = core.getInput('rule-prefix', { required: false }) || '';

    // Register the task definition
    core.debug('Registering the task definition');
    const taskDefPath = path.isAbsolute(taskDefinitionFile)
      ? taskDefinitionFile
      : path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
    const fileContents = fs.readFileSync(taskDefPath, 'utf8');
    const taskDefContents = removeIgnoredAttributes(
      cleanNullKeys(yaml.parse(fileContents))
    );
    let registerResponse;
    try {
      registerResponse = await ecs
        .registerTaskDefinition(taskDefContents)
        .promise();
      core.debug(`Register response: ${JSON.stringify(registerResponse)}`);
    } catch (error) {
      core.setFailed(
        'Failed to register task definition in ECS: ' + error.message
      );
      core.debug('Task definition contents:');
      core.debug(JSON.stringify(taskDefContents, undefined, 4));
      throw error;
    }
    const taskDefArn = registerResponse.taskDefinition.taskDefinitionArn;
    core.setOutput('task-definition-arn', taskDefArn);

    // TODO: Batch this?
    const data = await cwe.listRules().promise();
    const rules = (data && data.Rules) || [];
    await Promise.all(
      rules
        .filter((rule) => {
          return rule.Name.startsWith(rulePrefix);
        })
        .map((rule) => {
          return processCloudwatchEventRule(cwe, rule, cluster, taskDefArn);
        })
    );
  } catch (error) {
    core.setFailed(error.message);
    core.debug(error.stack);
  }
}

module.exports = run;

/* istanbul ignore next */
if (require.main === require.cache[eval('__filename')]) {
  run();
}


/***/ }),

/***/ 895:
/***/ ((module) => {

module.exports = eval("require")("@actions/core");


/***/ }),

/***/ 63:
/***/ ((module) => {

module.exports = eval("require")("aws-sdk");


/***/ }),

/***/ 21:
/***/ ((module) => {

module.exports = eval("require")("yaml");


/***/ }),

/***/ 747:
/***/ ((module) => {

"use strict";
module.exports = require("fs");;

/***/ }),

/***/ 622:
/***/ ((module) => {

"use strict";
module.exports = require("path");;

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		if(__webpack_module_cache__[moduleId]) {
/******/ 			return __webpack_module_cache__[moduleId].exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	__nccwpck_require__.ab = __dirname + "/";/************************************************************************/
/******/ 	// module exports must be returned from runtime so entry inlining is disabled
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	return __nccwpck_require__(865);
/******/ })()
;