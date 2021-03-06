import angular from 'angular';
import _ from 'lodash';
import * as utils from './utils';
import './zabbixAPI.service.js';
import './zabbixCachingProxy.service.js';

// Use factory() instead service() for multiple data sources support.
// Each Zabbix data source instance should initialize its own API instance.

/** @ngInject */
function ZabbixFactory(zabbixAPIService, ZabbixCachingProxy) {

  class Zabbix {
    constructor(url, username, password, basicAuth, withCredentials, cacheTTL) {

      // Initialize Zabbix API
      var ZabbixAPI = zabbixAPIService;
      this.zabbixAPI = new ZabbixAPI(url, username, password, basicAuth, withCredentials);

      // Initialize caching proxy for requests
      let cacheOptions = {
        enabled: true,
        ttl: cacheTTL
      };
      this.cachingProxy = new ZabbixCachingProxy(this.zabbixAPI, cacheOptions);

      // Proxy methods
      this.getHistory = this.cachingProxy.getHistory.bind(this.cachingProxy);
      this.getMacros = this.cachingProxy.getMacros.bind(this.cachingProxy);

      this.getTrend = this.zabbixAPI.getTrend.bind(this.zabbixAPI);
      this.getEvents = this.zabbixAPI.getEvents.bind(this.zabbixAPI);
      this.getAlerts = this.zabbixAPI.getAlerts.bind(this.zabbixAPI);
      this.getAcknowledges = this.zabbixAPI.getAcknowledges.bind(this.zabbixAPI);
      this.getITService = this.zabbixAPI.getITService.bind(this.zabbixAPI);
      this.getSLA = this.zabbixAPI.getSLA.bind(this.zabbixAPI);
      this.getVersion = this.zabbixAPI.getVersion.bind(this.zabbixAPI);
      this.login = this.zabbixAPI.login.bind(this.zabbixAPI);
    }

    getItemsFromTarget(target, options) {
      let parts = ['group', 'host', 'application', 'item'];
      let filters = _.map(parts, p => target[p].filter);
      return this.getItems(...filters, options);
    }

    getAllGroups() {
      return this.cachingProxy.getGroups();
    }

    getGroups(groupFilter) {
      return this.getAllGroups()
      .then(groups => findByFilter(groups, groupFilter));
    }

    /**
     * Get list of host belonging to given groups.
     */
    getAllHosts(groupFilter) {
      return this.getGroups(groupFilter)
      .then(groups => {
        let groupids = _.map(groups, 'groupid');
        return this.cachingProxy.getHosts(groupids);
      });
    }

    getHosts(groupFilter, hostFilter) {
      return this.getAllHosts(groupFilter)
      .then(hosts => findByFilter(hosts, hostFilter));
    }

    /**
     * Get list of applications belonging to given groups and hosts.
     */
    getAllApps(groupFilter, hostFilter) {
      return this.getHosts(groupFilter, hostFilter)
      .then(hosts => {
        let hostids = _.map(hosts, 'hostid');
        return this.cachingProxy.getApps(hostids);
      });
    }

    getApps(groupFilter, hostFilter, appFilter) {
      return this.getHosts(groupFilter, hostFilter)
      .then(hosts => {
        let hostids = _.map(hosts, 'hostid');
        if (appFilter) {
          return this.cachingProxy.getApps(hostids)
          .then(apps => filterByQuery(apps, appFilter));
        } else {
          return {
            appFilterEmpty: true,
            hostids: hostids
          };
        }
      });
    }

    getAllItems(groupFilter, hostFilter, appFilter, options = {}) {
      return this.getApps(groupFilter, hostFilter, appFilter)
      .then(apps => {
        if (apps.appFilterEmpty) {
          return this.cachingProxy.getItems(apps.hostids, undefined, options.itemtype);
        } else {
          let appids = _.map(apps, 'applicationid');
          return this.cachingProxy.getItems(undefined, appids, options.itemtype);
        }
      })
      .then(items => {
        if (!options.showDisabledItems) {
          items = _.filter(items, {'status': '0'});
        }

        return items;
      })
      .then(this.expandUserMacro.bind(this));
    }

    expandUserMacro(items) {
      let hostids = getHostIds(items);
      return this.getMacros(hostids)
      .then(macros => {
        _.forEach(items, item => {
          if (containsMacro(item.name)) {
            item.name = replaceMacro(item, macros);
          }
        });
        return items;
      });
    }

    getItems(groupFilter, hostFilter, appFilter, itemFilter, options = {}) {
      return this.getAllItems(groupFilter, hostFilter, appFilter, options)
      .then(items => filterByQuery(items, itemFilter));
    }

    /**
     * Build query - convert target filters to array of Zabbix items
     */
    getTriggers(groupFilter, hostFilter, appFilter, showTriggers, hideHostsInMaintenance) {
      let promises = [
        this.getGroups(groupFilter),
        this.getHosts(groupFilter, hostFilter),
        this.getApps(groupFilter, hostFilter, appFilter)
      ];

      return Promise.all(promises)
      .then(results => {
        let filteredGroups = results[0];
        let filteredHosts = results[1];
        let filteredApps = results[2];
        let query = {};

        if (appFilter) {
          query.applicationids = _.flatten(_.map(filteredApps, 'applicationid'));
        }
        if (hostFilter) {
          query.hostids = _.map(filteredHosts, 'hostid');
        }
        if (groupFilter) {
          query.groupids = _.map(filteredGroups, 'groupid');
        }

        return query;
      }).then(query => {
        return this.zabbixAPI
        .getTriggers(query.groupids, query.hostids, query.applicationids, showTriggers, hideHostsInMaintenance);
      });
    }
  }

  return Zabbix;
}

angular
  .module('grafana.services')
  .factory('Zabbix', ZabbixFactory);

///////////////////////////////////////////////////////////////////////////////

/**
 * Find group, host, app or item by given name.
 * @param  list list of groups, apps or other
 * @param  name visible name
 * @return      array with finded element or empty array
 */
function findByName(list, name) {
  var finded = _.find(list, {'name': name});
  if (finded) {
    return [finded];
  } else {
    return [];
  }
}

/**
 * Different hosts can contains applications and items with same name.
 * For this reason use _.filter, which return all elements instead _.find,
 * which return only first finded.
 * @param  {[type]} list list of elements
 * @param  {[type]} name app name
 * @return {[type]}      array with finded element or empty array
 */
function filterByName(list, name) {
  var finded = _.filter(list, {'name': name});
  if (finded) {
    return finded;
  } else {
    return [];
  }
}

function filterByRegex(list, regex) {
  var filterPattern = utils.buildRegex(regex);
  return _.filter(list, function (zbx_obj) {
    return filterPattern.test(zbx_obj.name);
  });
}

function findByFilter(list, filter) {
  if (utils.isRegex(filter)) {
    return filterByRegex(list, filter);
  } else {
    return findByName(list, filter);
  }
}

function filterByQuery(list, filter) {
  if (utils.isRegex(filter)) {
    return filterByRegex(list, filter);
  } else {
    return filterByName(list, filter);
  }
}

function getHostIds(items) {
  let hostIds = _.map(items, item => {
    return _.map(item.hosts, 'hostid');
  });
  return _.uniq(_.flatten(hostIds));
}

let MACRO_PATTERN = /{\$[A-Z0-9_\.]+}/g;

function containsMacro(itemName) {
  return MACRO_PATTERN.test(itemName);
}

function replaceMacro(item, macros) {
  let itemName = item.name;
  let item_macros = itemName.match(MACRO_PATTERN);
  _.forEach(item_macros, macro => {
    let host_macros = _.filter(macros, m => {
      if (m.hostid) {
        return m.hostid === item.hostid;
      } else {
        // Add global macros
        return true;
      }
    });

    let macro_def = _.find(host_macros, {macro: macro});
    if (macro_def && macro_def.value) {
      let macro_value = macro_def.value;
      let macro_regex = new RegExp(escapeMacro(macro));
      itemName = itemName.replace(macro_regex, macro_value);
    }
  });

  return itemName;
}

function escapeMacro(macro)  {
  macro = macro.replace(/\$/, '\\\$');
  return macro;
}
