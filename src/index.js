/* global -Promise */ // https://github.com/jshint/jshint/issues/1747

var npm = require('npm'),
    chalk = require('chalk'),
    Promise = require('bluebird'),
    moment = require('moment'),
    github = Promise.promisifyAll(require('octonode')),
    argv = require('minimist')(process.argv.slice(2)),
    logSymbols = require('log-symbols'),
    client = null, ghme = null,
    settings = {
      days: argv.days || 1
    };

function init (days) {
  settings.days = days || settings.days;

  return new Promise(function(resolve, reject) {
    npm.load({}, function(err) {
      if (err) {
        printError('Failed to load npm ...');
        reject(err);
      }

      settings.token = npm.config.get('daily-git:token');
      settings.username = npm.config.get('daily-git:username');

      if (!settings.token) {
        printError('Token is missing (https://github.com/settings/tokens/new)! Set it via:\n\tnpm config set daily-git:token <TOKEN>');
        return;
      }

      if (!settings.username) {
        printError('Username is missing! Set it via:\n\tnpm config set daily-git:username <USERNAME>');
        return;
      }

      client = github.client(settings.token);

      ghme = client.me();

      resolve();
    });
  });
}

function mapOrganization (org) {
  return client.org(org.login);
}

function mapRepository (repo) {
  return client.repo(repo.full_name);
}

function mapRepositories (repos) {
  return repos.map(function(repo) {
    return mapRepository(repo);
  });
}

function getRepoData (repo) {
  var split = repo.name.split('/'),
      owner = split[0],
      name = split[1];

  return {
    repo: repo,
    owner: owner,
    name: name
  };
}

function getDailyDate () {
  var dailyDay = moment().subtract(settings.days, 'days').startOf('day'),
      dayCount = dailyDay.get('day');

  if (dayCount === 6) { // saturday
    dailyDay = dailyDay.subtract(1, 'days');
  } else if (dayCount === 0) { // saturday
    dailyDay = dailyDay.subtract(2, 'days');
  }

  return dailyDay.format();
}

function getRepoCommits (repoData, branch) {
  return new Promise(function(resolve, reject) {
    client.get('/repos/' + repoData.owner + '/' + repoData.name + '/commits', {
      author: settings.username,
      since: getDailyDate(),
      sha: branch.name
    }, function(err, status, body, headers) {
      if (err) { reject(err); }

      var commits = Array.prototype.slice.call(body || []);

      resolve(commits);
    });
  }).catch(function(e) {
    printError('Error occured while loading commits for ' + repoData.owner + '/' + repoData.name + ': ' + e);
    return [];
  });
}

function printUnderline (str) {
  console.log(chalk.gray(new Array(str.length + 1).join('=')));
}

function printError (str) {
  console.log(logSymbols.error + ' ' + str);
}

function printInfo (str, printNewLine) {
  var newLine = printNewLine ? '\n' : '';
  console.log(newLine + logSymbols.info + ' ' + str);
}

function printRepoData (repoData, branch) {
  var spacer = ' // ',
      headline = [
        chalk.cyan(repoData.owner),
        chalk.gray(spacer),
        chalk.cyan(repoData.name),
        chalk.gray(spacer),
        chalk.gray(branch.name)
      ].join('');

  console.log('\n' + headline);
  printUnderline(repoData.owner + spacer + repoData.name + spacer + branch.name);
}

function printCommit (commit) {
  var message = commit.commit.message,
      date = moment(commit.commit.committer.date).format('L HH:MM'),
      spacer = ' | ',
      dateSpacerCount = (date + spacer).length;

  message = message.replace(/\n/g, '\n' + new Array(dateSpacerCount + 1).join(' '));

  console.log(chalk.gray(date + spacer) + chalk.cyan(message));
}

function printLimit () {
  return getLimit().then(function(limit) {
    printInfo(limit.left + ' requests left. ' + chalk.gray(' (max: ' + limit.max + ')'), true);
  });
}

function printDaily () {
  return getReposBranchesAndCommits().each(function(result) {
    result.branches.forEach(function(branch) {
      if (branch.commits.length) {
        printRepoData(result.repoData, branch);
        branch.commits.forEach(printCommit);
      }
    });
  });
}

function getOrganizationRepos () {
  return ghme.orgsAsync().get(0)
    .map(mapOrganization)
    .map(function(organization) {
      return organization.reposAsync();
    }).then(function(results) {
      var repositories = [];

      results.forEach(function(result) {
        repositories = repositories.concat(mapRepositories(result[0]));
      });

      return repositories;
    }).catch(function(e) {
      printError('Error occured while loading organization repos: ' + e);
      return [];
    }).tap(function(organizationRepos) {
      if (!organizationRepos.length) {
        printInfo(settings.username + ' has no organization repositories.');
      } else {
        printInfo(organizationRepos.length + ' organization repositories found.');
      }
    });
}

function getRepos () {
  return ghme.reposAsync().get(0)
    .map(mapRepository).catch(function(e) {
      printError('Error occured while loading repos: ' + e);
      return [];
    }).tap(function(repos) {
      if (!repos.length) {
        printInfo(settings.username + ' has no repositories.');
      } else {
        printInfo(repos.length + ' repositories found.');
      }
    });
}

function getBranches (repo) {
  return repo.branchesAsync().get(0);
}

function getLimit () {
  var clientLimitAsync = Promise.promisify(client.limit);

  return clientLimitAsync().spread(function(left, max) {
    return {
      left: left,
      max: max
    };
  });
}

function getAllRepos () {
  return Promise.join(getOrganizationRepos(), getRepos()).spread(function(organizationRepos, repos) {
    return organizationRepos.concat(repos);
  });
}

function getReposBranchesAndCommits () {
  return getAllRepos().map(function(repository) {
    return Promise.all([
      getRepoData(repository),
      getBranches(repository)
    ]);
  }).map(function(result) { // mapSpread is missing ...
    var repoData = result[0],
        branches = result[1],
        commits = [];

    branches.forEach(function(branch) {
      commits.push(getRepoCommits(repoData, branch));
    });

    return Promise.all([
      repoData,
      branches
    ].concat(commits));
  }).map(function(result) {
    var repoData = result[0],
        branches = result[1],
        commits = result.splice(2);

    branches.forEach(function(branch, index) {
      branch.commits = commits[index];
    });

    return {
      repoData: repoData,
      branches: branches
    };
  });
}

module.exports = {
  print: {
    info: printInfo,
    daily: printDaily,
    error: printError,
    limit: printLimit,
    commit: printCommit,
    repoData: printRepoData
  },
  init: init,
  limit: getLimit,
  getRepos: getRepos,
  getBranches: getBranches,
  getAllRepos: getAllRepos,
  getRepoCommits: getRepoCommits,
  getOrganizationRepos: getOrganizationRepos,
  getReposBranchesAndCommits: getReposBranchesAndCommits
};
