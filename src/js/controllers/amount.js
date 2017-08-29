'use strict';

angular.module('copayApp.controllers').controller('amountController', function($scope, $filter, $timeout, $ionicScrollDelegate, $ionicHistory, gettextCatalog, platformInfo, lodash, configService, rateService, $stateParams, $window, $state, $log, txFormatService, ongoingProcess, popupService, bwcError, payproService, profileService, bitcore, amazonService, nodeWebkitService) {
  var _id;
  var unitToSatoshi;
  var satToUnit;
  var unitDecimals;
  var satToBtc;
  var SMALL_FONT_SIZE_LIMIT = 10;
  var LENGTH_EXPRESSION_LIMIT = 19;
  var isNW = platformInfo.isNW;

  var unitIndex = 0;
  var altUnitIndex = 0;
  var availableUnits = [];
  var fiatCode;

  $scope.isChromeApp = platformInfo.isChromeApp;

  $scope.$on('$ionicView.leave', function() {
    angular.element($window).off('keydown');
  });

  $scope.$on("$ionicView.beforeEnter", function(event, data) {

    var config = configService.getSync().wallet.settings;

    function setAvailableUnits() {

      availableUnits = [{
        name: 'Bitcoin',
        id: 'btc',
        shortName: 'BTC',
      }];

     
      var anyCashWallet = true;  // TODO!!
      if (anyCashWallet) {
        availableUnits.push({
          name: 'Bitcoin Cash',
          id: 'bch',
          shortName: 'BCH',
        });
      };


      var fiat;
      if (data.stateParams.currency) {
        fiat = data.stateParams.currency;
      } else {
        fiat = config.fiat || 'USD';
      }

      availableUnits.push({
        name: fiat, // TODO
        id: fiat,
        shortName: fiat,
        isFiat: true,
      });

      unitIndex = 0;
      altUnitIndex = availableUnits.length - 1;
      fiatCode = fiat;
    };

    // Go to...
    _id = data.stateParams.id; // Optional (BitPay Card ID or Wallet ID)
    $scope.nextStep = data.stateParams.nextStep;

    $scope.forceCurrency = data.stateParams.forceCurrency;
    $scope.forceCoin = data.stateParams.forceCoin;

    if (data.stateParams.coin) {
       var index = lodash.findIndex(availableUnits, { id: data.stateParams.coin });
 
       if (index < 0) {
         $log.warn('Could not find desired coin:' + data.stateParams.coin)
       } else {
         unitIndex = index;
       }
    }

    setAvailableUnits();
    updateUnitUI();

    $scope.showMenu = $ionicHistory.backView() && ($ionicHistory.backView().stateName == 'tabs.send' ||
      $ionicHistory.backView().stateName == 'tabs.bitpayCard');
    $scope.recipientType = data.stateParams.recipientType || null;
    $scope.toAddress = data.stateParams.toAddress;
    $scope.toName = data.stateParams.toName;
    $scope.toEmail = data.stateParams.toEmail;
    $scope.toColor = data.stateParams.toColor;
    $scope.showSendMax = false;

    if (!$scope.nextStep && !data.stateParams.toAddress) {
      $log.error('Bad params at amount')
      throw ('bad params');
    }

    var reNr = /^[1234567890\.]$/;
    var reOp = /^[\*\+\-\/]$/;

    var disableKeys = angular.element($window).on('keydown', function(e) {
      if (!e.key) return;
      if (e.which === 8) { // you can add others here inside brackets.
        e.preventDefault();
        $scope.removeDigit();
      }

      if (e.key.match(reNr)) {
        $scope.pushDigit(e.key);
      } else if (e.key.match(reOp)) {
        $scope.pushOperator(e.key);
      } else if (e.keyCode === 86) {
        if (e.ctrlKey || e.metaKey)
          processClipboard();
      } else if (e.keyCode === 13)
        $scope.finish();

      $timeout(function() {
        $scope.$apply();
      });
    });
    $scope.specificAmount = $scope.specificAlternativeAmount = '';
    $scope.isCordova = platformInfo.isCordova;
    unitToSatoshi = config.unitToSatoshi;
    satToUnit = 1 / unitToSatoshi;
    satToBtc = 1 / 100000000;
    unitDecimals = config.unitDecimals;

    $scope.resetAmount();

    // in SAT ALWAYS
    if ($stateParams.toAmount) {
      $scope.amount = (($stateParams.toAmount) * satToUnit).toFixed(unitDecimals);
    }

    processAmount();

    $timeout(function() {
      $ionicScrollDelegate.resize();
    }, 10);
  });

  function paste(value) {
    $scope.amount = value;
    processAmount();
    $timeout(function() {
      $scope.$apply();
    });
  };

  function processClipboard() {
    if (!isNW) return;
    var value = nodeWebkitService.readFromClipboard();
    if (value && evaluate(value) > 0) paste(evaluate(value));
  };

  $scope.showSendMaxMenu = function() {
    $scope.showSendMax = true;
  };

  $scope.sendMax = function() {
    $scope.showSendMax = false;
    $scope.useSendMax = true;
    $scope.finish();
  };


  $scope.toggleAlternative = function() {
    if ($scope.amount && isExpression($scope.amount)) {
      var amount = evaluate(format($scope.amount));
      $scope.globalResult = '= ' + processResult(amount);
    }
  };

  function updateUnitUI() {

    $scope.unit = availableUnits[unitIndex].shortName;
    $scope.alternativeUnit = availableUnits[altUnitIndex].shortName;

    processAmount();
    $log.debug('Update unit coin @amount unit:' + $scope.unit + " alternativeUnit:" + $scope.alternativeUnit); //TODO
  };

  $scope.changeUnit = function() {
    if ($scope.forceCurrency || $scope.forceCoin) return;

    unitIndex++;
    if (unitIndex >= availableUnits.length) unitIndex = 0;


    if (availableUnits[unitIndex].isFiat) {
      // Always return to BTC... TODO?
      altUnitIndex = 0;
    } else {
      altUnitIndex = lodash.findIndex(availableUnits, {
        isFiat: true
      });
    }

    updateUnitUI();
  };


  $scope.changeAlternativeUnit = function() {
    console.log('[amount.js.215:changeAlternativeUnit:]'); //TODO

    // Do nothing is fiat is not main unit
    if (!availableUnits[unitIndex].isFiat) return;

    var nextCoin = lodash.findIndex(availableUnits, function(x) {
      if (x.isFiat) return false;
      if (x.id == availableUnits[altUnitIndex].id) return false;
      return true;
    });

    if (nextCoin >= 0) {
      altUnitIndex = nextCoin;
      updateUnitUI();
    }
  };

  function checkFontSize() {
    if ($scope.amount && $scope.amount.length >= SMALL_FONT_SIZE_LIMIT) $scope.smallFont = true;
    else $scope.smallFont = false;
  };

  $scope.pushDigit = function(digit) {
    if ($scope.amount && $scope.amount.length >= LENGTH_EXPRESSION_LIMIT) return;
    if ($scope.amount.indexOf('.') > -1 && digit == '.') return;
    if (availableUnits[unitIndex].isFiat && $scope.amount.indexOf('.') > -1 && $scope.amount[$scope.amount.indexOf('.') + 2]) return;

    $scope.amount = ($scope.amount + digit).replace('..', '.');
    checkFontSize();
    processAmount();
  };

  $scope.pushOperator = function(operator) {
    if (!$scope.amount || $scope.amount.length == 0) return;
    $scope.amount = _pushOperator($scope.amount);

    function _pushOperator(val) {
      if (!isOperator(lodash.last(val))) {
        return val + operator;
      } else {
        return val.slice(0, -1) + operator;
      }
    };
  };

  function isOperator(val) {
    var regex = /[\/\-\+\x\*]/;
    return regex.test(val);
  };

  function isExpression(val) {
    var regex = /^\.?\d+(\.?\d+)?([\/\-\+\*x]\d?\.?\d+)+$/;
    return regex.test(val);
  };

  $scope.removeDigit = function() {
    $scope.amount = ($scope.amount).toString().slice(0, -1);
    processAmount();
    checkFontSize();
  };

  $scope.resetAmount = function() {
    $scope.amount = $scope.alternativeAmount = $scope.globalResult = '';
    $scope.allowSend = false;
    checkFontSize();
  };

  function processAmount() {
    var formatedValue = format($scope.amount);
    var result = evaluate(formatedValue);
    $scope.allowSend = lodash.isNumber(result) && +result > 0;
    if (lodash.isNumber(result)) {
      $scope.globalResult = isExpression($scope.amount) ? '= ' + processResult(result) : '';

      if (availableUnits[unitIndex].isFiat) {
        $scope.alternativeAmount = txFormatService.formatAmount(fromFiat(result) * unitToSatoshi, true);
      } else {
        $scope.alternativeAmount = $filter('formatFiatAmount')(toFiat(result));
      }
    }
  };

  function processResult(val) {
    if (availableUnits[unitIndex].isFiat)
      return $filter('formatFiatAmount')(val);
    else
      return txFormatService.formatAmount(val.toFixed(unitDecimals) * unitToSatoshi, true);
  };

  function fromFiat(val) {
    return parseFloat((rateService.fromFiat(val, fiatCode, availableUnits[altUnitIndex].id) * satToUnit).toFixed(unitDecimals));
  };

  function toFiat(val) {
    return parseFloat((rateService.toFiat(val * unitToSatoshi, fiatCode, availableUnits[unitIndex].id)).toFixed(2));
  };

  function evaluate(val) {
    var result;
    try {
      result = $scope.$eval(val);
    } catch (e) {
      return 0;
    }
    if (!lodash.isFinite(result)) return 0;
    return result;
  };

  function format(val) {
    if (!val) return;

    var result = val.toString();

    if (isOperator(lodash.last(val)))
      result = result.slice(0, -1);

    return result.replace('x', '*');
  };

  $scope.finish = function() {

    var unit = availableUnits[unitIndex];
    var _amount = evaluate(format($scope.amount));

    if ($scope.nextStep) {

      var coin = unit.id;
      if (unit.isFiat) {
        coin =  availableUnits[altUnitIndex].id;
      }

      $state.transitionTo($scope.nextStep, {
        id: _id,
        amount: $scope.useSendMax ? null : _amount,
        currency: unit.id.toUpperCase(),
        coin: coin,
        useSendMax: $scope.useSendMax
      });
    } else {
      var amount = _amount;

      if (unit.isFiat) {
        amount = fromFiat(_amount);
      } else if ($scope.useSendMax){
        amount = (amount * unitToSatoshi).toFixed(0);
      }


      $state.transitionTo('tabs.send.confirm', {
        recipientType: $scope.recipientType,
        toAmount: amount,
        toAddress: $scope.toAddress,
        toName: $scope.toName,
        toEmail: $scope.toEmail,
        toColor: $scope.toColor,
        coin: unit.id,
        useSendMax: $scope.useSendMax
      });
    }
    $scope.useSendMax = null;
  };
});
