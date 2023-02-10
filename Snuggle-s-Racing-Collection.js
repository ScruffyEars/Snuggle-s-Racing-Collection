// ==UserScript==
// @name         Snuggle's: Racing Collection
// @namespace    Snuggle-s-Racing-Collection
// @version      0.0.1
// @description  Show car's current speed, precise skill, official race penalty, racing skill of others, race car skins and several added statistics
// @author       Snuggle
// @match        https://www.torn.com/*
// @require      https://raw.githubusercontent.com/f2404/torn-userscripts/e3bb87d75b44579cdb6f756435696960e009dc84/lib/lugburz_lib.js
// @connect      api.torn.com
// @connect      race-skins.brainslug.nl
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @run-at       document-body
// ==/UserScript==

//Based on Lugburz [2386297] great script
//Big parts from Brainslug [2323221] awesome script collection

//Should current speed be shown at the bottom of the map
const optionShowSpeed = GM_getValue('showSpeedChk') != 0;

// whether to show the top3 position icon
const SHOW_POSITION_ICONS = GM_getValue('showPositionIconChk') != 0;

//Should Racing skills be displayed for others, requires API key to query with
let optionGetRacingSkills = (GM_getValue('apiKey') && GM_getValue('apiKey').length > 0);
//Should Car skins be shown for those having them
const optionShowCustomCarSkin = GM_getValue('showSkinsChk') != 0;
//Url to brainslugs racing skin data
const brainslugRaceSkinUrl = 'https://race-skins.brainslug.nl/custom/data';
//Baseurl to brainslugs racing skin images
const brainslugSkinImageUrl = 'https://race-skins.brainslug.nl/assets';

//Racing skills stored in the cache
const cachedRacingSkills = new Map();
//Flag for when the leaderboard is already being updated
let leaderBoardUpdating = false;
//Used as the time to wait between API batches
const apiWaitTime = 1500;
//Used to indicate if the left menu current car is skinned and which skin it is
let skinnedCarInMenu = null;
//Used to keep track of running intervals so multiple doesn't stack and break the browser
let currentSpeedInterval = 0;
//Stores the last completed % point, used in speed calculation
let lastCompletedLap = -1.0;
//Used to indicate the time between recalculating the cars current speed
let speedCalculationIntervalPeriod = 1000;
const userID = getUserIdFromCookie();
var raceId = '*';
var penaltyNotif = 0;
var racingSkills = {};

let _skinOwnerCache = null;

function getUserIdFromCookie() {
    const userIdString = document.cookie.split(';')
        .map(entry => entry.trim())
        .find(entry => entry.indexOf('uid=') === 0)
        .replace('uid=', '');

    return parseInt(userIdString, 10);
}

function formatDate(date) {
    const month = (+date.getUTCMonth()) + (+1);
    return date.getUTCFullYear() + '-' + pad(month, 2) + '-' + pad(date.getUTCDate(), 2) + ' ' + formatTime(date);
}

function updateSkill(level) {
    const skill = Number(level).toFixed(5);
    const prev = GM_getValue('racinglevel');

    const now = Date.now();
    const lastDaysRs = GM_getValue('lastDaysRs');
    if (lastDaysRs && lastDaysRs.includes(':')) {
        const ts = lastDaysRs.split(':')[0];
        const dateTs = new Date();
        dateTs.setTime(ts);
        if (1 * (new Date(now).setUTCHours(0, 0, 0, 0)) - 1 * (dateTs.setUTCHours(0, 0, 0, 0)) >= 24*60*60*1000) {
            GM_setValue('lastDaysRs', `${now}:${prev ? prev : skill}`);
        }
    } else {
        GM_setValue('lastDaysRs', `${now}:${prev ? prev : skill}`);
    }

    GM_setValue('racinglevel', level);

    if ($('#racingMainContainer').find('div.skill').size() > 0) {
        if ($("#sidebarroot").find("a[class^='menu-value']").size() > 0) {
            // move the elements to the left a little bit to fit 5th decimal digit in desktop mode
            $('#racingMainContainer').find('div.skill-desc').css('left', '5px');
            $('#racingMainContainer').find('div.skill').css('left', '5px').text(skill);
        } else {
            $('#racingMainContainer').find('div.skill').text(skill);
        }

        const lastInc = GM_getValue('lastRSincrement');
        if (lastInc) {
            $('div.skill').append(`<div style="margin-top: 10px;">Last gain: ${lastInc}</div>`);
        }
    }
}

function updatePoints(pointsearned) {
    const now = Date.now();
    const lastDaysPoints = GM_getValue('lastDaysPoints');
    const prev = GM_getValue('pointsearned');
    if (lastDaysPoints && lastDaysPoints.includes(':')) {
        const ts = lastDaysPoints.split(':')[0];
        const dateTs = new Date();
        dateTs.setTime(ts);
        if (1 * (new Date(now).setUTCHours(0, 0, 0, 0)) - 1 * (dateTs.setUTCHours(0, 0, 0, 0)) >= 24*60*60*1000) {
            GM_setValue('lastDaysPoints', `${now}:${prev ? prev : pointsearned}`);
        }
    } else {
        GM_setValue('lastDaysPoints', `${now}:${prev ? prev : pointsearned}`);
    }
    GM_setValue('pointsearned', pointsearned);
}

function parseRacingData(data) {
    // no sidebar in phone mode
    const my_name = $("#sidebarroot").find("a[class^='menu-value']").html() || data.user.playername;

    updateSkill(data['user']['racinglevel']);
    updatePoints(data['user']['pointsearned']);

    const leavepenalty = data['user']['leavepenalty'];
    GM_setValue('leavepenalty', leavepenalty);
    checkPenalty();

    // display race link
    if ($('#raceLink').size() < 1) {
        raceId = data.raceID;
        const raceLink = `<a id="raceLink" href="https://www.torn.com/loader.php?sid=racing&tab=log&raceID=${raceId}" style="float: right; margin-left: 12px;">Link to the race</a>`;
        $(raceLink).insertAfter('#racingEnhSettings');
    }

    // calc, sort & show race results
    if (data.timeData.status >= 3) {
        const carsData = data.raceData.cars;
        const carInfo = data.raceData.carInfo;
        const trackIntervals = data.raceData.trackData.intervals.length;
        let results = [], crashes = [];

        for (const playername in carsData) {
            const intervals = decode64(carsData[playername]).split(',');
            let raceTime = 0;
            let bestLap = 9999999999;

            if (intervals.length / trackIntervals == data.laps) {
                for (let i = 0; i < data.laps; i++) {
                    let lapTime = 0;
                    for (let j = 0; j < trackIntervals; j++) {
                        lapTime += Number(intervals[i * trackIntervals + j]);
                    }
                    bestLap = Math.min(bestLap, lapTime);
                    raceTime += Number(lapTime);
                }
                results.push([playername, carInfo[playername].userID, raceTime, bestLap, carInfo[playername].carTitle, "https://www.torn.com/"+carInfo[playername].carImage]);
            } else {
                crashes.push([playername, carInfo[playername].userID, 'crashed', carInfo[playername].carTitle, "https://www.torn.com/"+carInfo[playername].carImage]);
            }
        }

        // sort by time
        results.sort(compare);
        addExportButton(results, crashes, my_name, data.raceID, data.timeData.timeEnded);

        if (SHOW_RESULTS) {
            showResults(results);
            showResults(crashes, results.length);
        }
    }
}

// compare by time
function compare(a, b) {
    if (a[2] > b[2]) return 1;
    if (b[2] > a[2]) return -1;

    return 0;
}

GM_addStyle(`
.rs-display {
    position: absolute;
    right: 5px;
}
li.name .race_position {
  background:url(/images/v2/racing/car_status.svg) 0 0 no-repeat;
  display:inline-block;
  width:20px;
  height:18px;
  vertical-align:text-bottom;
}
li.name .race_position.gold {
  background-position:0 0;
}
li.name .race_position.silver {
  background-position:0 -22px;
}
li.name .race_position.bronze {
  background-position:0 -44px;
}`);

function showResults(results, start = 0) {
    for (let i = 0; i < results.length; i++) {
        $('#leaderBoard').children('li').each(function() {
            const name = $(this).find('li.name').text().trim();
            if (name == results[i][0]) {
                const p = i + start + 1;
                const position = p === 1 ? 'gold' : (p === 2 ? 'silver' : (p === 3 ? 'bronze' : ''));
                let place;
                if (p != 11 && (p%10) == 1)
                    place = p + 'st';
                else if (p != 12 && (p%10) == 2)
                    place = p + 'nd';
                else if (p != 13 && (p%10) == 3)
                    place = p + 'rd';
                else
                    place = p + 'th';

                const result = typeof results[i][2] === 'number' ? formatTimeMsec(results[i][2] * 1000) : results[i][2];
                const bestLap = results[i][3] ? formatTimeMsec(results[i][3] * 1000) : null;
                $(this).find('li.name').html($(this).find('li.name').html().replace(name, ((SHOW_POSITION_ICONS && position) ? `<i class="race_position ${position}"></i>` : '') + `${name} ${place} ${result}` + (bestLap ? ` (best: ${bestLap})` : '')));
                return false;
            }
        });
    }
}

function addExportButton(results, crashes, my_name, race_id, time_ended) {
    if ($("#racingupdatesnew").size() > 0 && $('#downloadAsCsv').size() < 1) {
        const exportBtn = `<a id="downloadAsCsv" style="float: right; margin-left: 12px;">Download results as CSV</a>`;
        $(exportBtn).insertAfter('#racingEnhSettings');

		/** Formats the results into a CSV file on click **/
		$("#downloadAsCsv").click(function() {
			let csv = '';
			const titleDiv = $("div[id='racingupdates'] > div[id='racingupdatesnew'] > div.car-selected-wrap > div.car-selected > div.title-black");
			if (titleDiv[0].innerText == "Race info") {
				const raceInfoProperties = $("div[id='racingupdates'] > div[id='racingupdatesnew'] > div.car-selected-wrap > div.car-selected > div > ul.properties-wrap > li > div.properties > div.title");
				if (raceInfoProperties.length > 0) {
					for (let index = 0; index < raceInfoProperties.length; index++) {
						const propertyText = raceInfoProperties[index].innerText;
						csv += `${propertyText.replace(': ', ',')}\n`;
					}
				}
			}
			csv += 'position,name,id,time,best_lap,rs,car,car_image\n';
			for (let i = 0; i < results.length; i++) {
				const timeStr = formatTimeMsec(results[i][2] * 1000, true);
				const bestLap = formatTimeMsec(results[i][3] * 1000);
				//Exchange '' with displayed RS
				csv += `${[i+1, results[i][0], results[i][1], timeStr, bestLap, (results[i][0] === my_name ? GM_getValue('racinglevel') : racingSkills[results[i][1]]), results[i][4], results[i][5]].join(',')}\n`;
			}
			for (let i = 0; i < crashes.length; i++) {
				csv += `${[results.length + i + 1, crashes[i][0], crashes[i][1], crashes[i][2], '', (results[i][0] === my_name ? GM_getValue('racinglevel') : ''), results[i][3], results[i][4]].join(',')}\n`;
			}

			const timeE = new Date();
			timeE.setTime(time_ended * 1000);
			const fileName = `${timeE.getUTCFullYear()}${pad(timeE.getUTCMonth() + 1, 2)}${pad(timeE.getUTCDate(), 2)}-race_${race_id}.csv`;

			const myblob = new Blob([csv], {type: 'application/octet-stream'});
			const myurl = window.URL.createObjectURL(myblob);
			const exportBtn = `<a id="hiddenDownloadAsCsv" href="${myurl}" style="visibility: hidden;" download="${fileName}"/>`;
			$(exportBtn).insertAfter('#racingEnhSettings');
			document.getElementById("hiddenDownloadAsCsv").click();
		});
    }
}

function addPlaybackButton() {
    if ($("#racingupdatesnew").size() > 0 && $('div.race-player-container').size() < 1) {
        $('div.drivers-list > div.cont-black').prepend(`<div class="race-player-container"><button id="play-pause-btn" class="play"></button>
<div id="speed-slider"><span id="prev-speed" class="disabled"></span><span id="speed-value">x1</span><span id="next-speed" class="enabled"></span></div>
<div id="replay-bar-container"><span id="progress-active"></span><span id="progress-inactive"></span></div>
<div id="race-timer-container"><span id="race-timer">00:00:00</span></div></div>`);
    }
}

function displayDailyGains() {
    $('#mainContainer').find('div.content').find('span.label').each((i, el) => {
        if ($(el).text().includes('Racing')) {
            const racingLi = $(el).parent().parent();

            // RS gain
            const desc = $(racingLi).find('span.desc');
            if ($(desc).size() > 0) {
                const rsText = $(desc).text();
                const currentRs = GM_getValue('racinglevel');
                const lastDaysRs = GM_getValue('lastDaysRs');
                const oldRs = lastDaysRs && lastDaysRs.includes(':') ? lastDaysRs.split(':')[1] : undefined;
                $(desc).text(`${rsText} / Daily gain: ${currentRs && oldRs ? (1*currentRs - 1*oldRs).toFixed(5) : 'N/A'}`);
                $(desc).attr('title', 'Daily gain: How much your racing skill has increased since yesterday.');
            }

            // points gain
            const lastDaysPoints = GM_getValue('lastDaysPoints');
            const currentPoints = GM_getValue('pointsearned');
            const oldPoints = lastDaysPoints && lastDaysPoints.includes(':') ? lastDaysPoints.split(':')[1] : undefined;
            let pointsTitle = 'Racing points earned: How many points you have earned throughout your carreer.';
            for (const x of [ {points: 25, class: 'D'}, {points: 100, class: 'C'}, {points: 250, class: 'B'}, {points: 475, class: 'A'} ]) {
                if (currentPoints && currentPoints < x.points) pointsTitle += `<br>Till <b>class ${x.class}</b>: ${1*x.points - 1*currentPoints}`;
            }
            const pointsLi = `<li role="row"><span class="divider"><span class="label" title="${pointsTitle}">Racing points earned</span></span>
<span class="desc" title="Daily gain: How many racing points you've earned since yesterday.">
${currentPoints ? currentPoints : 'N/A'} / Daily gain: ${currentPoints && oldPoints ? 1*currentPoints - 1*oldPoints : 'N/A'}
</span>
</li>`;
            $(pointsLi).insertAfter(racingLi);

            return false;
        }
    });
}

'use strict';
/**
 * Fires every time an ajax request has been completed and checked for the loader of the page, which got the info of the race
 */
$(document).ajaxComplete((event, xhr, settings) => {
    //Looking for readyState 4 which means DONE
    //Also checking the status to be 200 which means it didn't fail and is either LOADING or DONE
    if (xhr.readyState > 3 && xhr.status == 200) {
        let url = settings.url;
        //If the path is relative Torn is added to the front for ease of cutting
        if (url.indexOf("torn.com/") < 0) {
            url = `torn.com${url.startsWith("/") ? "" : "/"}${url}`
        }
        //Remove the torn and .php bits form the url to make it just show the action
        const page = url.substring(`${url.indexOf("torn.com/")}torn.com/`.length, url.indexOf(".php"));
        //If it is not the loader page we are not interested
        if (page != "loader") {
            return;//Do nothing
        }
        //We got the right ajax query
        //Append the settings menu
        $("#racingupdatesnew").ready(CreateSettingsMenu);
        //Appends speed information below the map if chosen
        $("#racingupdatesnew").ready(CreateSpeedInformationAndCalculation);
        //Check if the current user is under penalty for leaving an official race
        $('#racingAdditionalContainer').ready(CheckForPenaltyAndDisplayTime);
        debugger;
        if ($(location).attr('href').includes('sid=racing&tab=log&raceID=')) {
            $('#racingupdatesnew').ready(addPlaybackButton);
        }
        try {
            parseRacingData(JSON.parse(xhr.responseText));
        } catch (e) {}

        const JltColor = '#fff200';
        if ($('#racingAdditionalContainer').size() > 0 && $('#racingAdditionalContainer').find('div.custom-events-wrap').size() > 0) {
            $('#racingAdditionalContainer').find('div.custom-events-wrap').find('ul.events-list > li').each((i, li) => {
                if ($(li).find('li.name').size() > 0 && $(li).find('li.name').text().trim().startsWith('JLT-')) {
                    $(li).addClass('gold');
                    $(li).css('color', JltColor).css('text-shadow', `0 0 1px ${JltColor}`);
                    $(li).find('span.laps').css('color', JltColor);
                }
            });
        }
    }
});

$("#racingupdatesnew").ready(CreateSettingsMenu);
$("#racingupdatesnew").ready(CreateSpeedInformationAndCalculation);
$('#racingAdditionalContainer').ready(CheckForPenaltyAndDisplayTime);

if ($(location).attr('href').includes('index.php')) {
    $('#mainContainer').ready(displayDailyGains);
}

if ($(location).attr('href').includes('sid=racing&tab=log&raceID=')) {
    $('#racingupdatesnew').ready(addPlaybackButton);
}

// hide playback button when not showing a race log
$('#racingupdatesnew').ready(function() {
    $('div.racing-main-wrap').find('ul.categories > li > a').on('click', function() {
        $('#racingupdatesnew').find('div.race-player-container').hide();
    });
});

checkPenalty();

if ((optionGetRacingSkills || optionShowCustomCarSkin) && $(location).attr('href').includes('sid=racing')) {
    $("#racingupdatesnew").ready(function() {
        UpdateLeaderboard();
        // On change race tab, (re-)insert the racing skills if applicable:
        new MutationObserver(UpdateLeaderboard).observe(document.getElementById('racingAdditionalContainer'), {childList: true});
    });
}



/**
 * Append setting options so the user can customize their needs
 */
function CreateSettingsMenu() {
    //#TODO: Change to config cog button with a nice menu, styled like Brainslug's
    if ($("#racingupdatesnew").size() > 0 && $('#racingEnhSettings').size() < 1) {
        //Creates the visible options
        const div = '<div style="font-size: 12px; line-height: 24px; padding-left: 10px; padding-right: 10px; background: repeating-linear-gradient(90deg,#242424,#242424 2px,#2e2e2e 0,#2e2e2e 4px); border-radius: 5px;">' +
              '<a id="racingEnhSettings" style="text-align: right; cursor: pointer;">Settings</a>' +
              '<div id="racingEnhSettingsContainer" style="display: none;"><ul style="color: #ddd;">' +
              '<li><input type="checkbox" style="margin-left: 5px; margin-right: 5px" id="showSpeedChk"><label>Show current speed</label></li>' +
              '<li><input type="checkbox" style="margin-left: 5px; margin-right: 5px" id="showSkinsChk"><label>Show racing skins</label></li>' +
              '<li><input type="checkbox" style="margin-left: 5px; margin-right: 5px" id="showPositionIconChk"><label>Show position icons</label></li>' +
              '<li><label>Fetch racing skill from the API (<a href="https://www.torn.com/preferences.php#tab=api">link to your API key</a>)</label><span class="input-wrap" style="margin: 0px 5px 5px;">' +
              '<input type="text" autocomplete="off" data-lpignore="true" id="apiKey"></span>' +
              '<a href="#" id="saveApiKey" class="link btn-action-tab tt-modified"><i style="display: inline-block; background: url(/images/v2/racing/car_enlist.png) 0 0 no-repeat; vertical-align: middle; height: 15px; width: 15px;"></i>Save</a></li></ul></div></div>';
        $('#racingupdatesnew').prepend(div);

        //Change checkboxes based on saved settings
        $('#racingEnhSettingsContainer').find('input[type=checkbox]').each(function() {
            //Access Tampermonkey storage to get users earlier choice
            $(this).prop('checked', GM_getValue($(this).attr('id')) != 0);
        });
        //Gets the stored API key from Tampermonkey storage
        $('#apiKey').val(GM_getValue('apiKey'));
        //Setting up the click event for the settings Text
        $('#racingEnhSettings').on('click', () => {
            //Toggles the settings container
            $('#racingEnhSettingsContainer').toggle();
        });
        //Setup click events for the inputs in the settings menu
        $('#racingEnhSettingsContainer').on('click', 'input', function() {
            const id = $(this).attr('id');
            const checked = $(this).prop('checked');
            //Store the choice in the Tampermonkey storage
            GM_setValue(id, checked ? 1 : 0);
        });
        //Click event for when the save API key button is pressed
        $('#saveApiKey').click(event => {
            event.preventDefault();
            event.stopPropagation();
            //Store the API key in the Tampermonkey storage
            GM_setValue('apiKey', $('#apiKey').val());
            //Update the leaderboard, now with changed permissions
            UpdateLeaderboard();
        });
    }
}

/**
 * Updates the presented driver leaderboard list below the map
 */
async function UpdateLeaderboard() {
    //Gets the current leaderboard element
    const leaderBoard = document.getElementById('leaderBoard');
    //If a process is already updating or the leaderboard isn't loaded, skip
    if (leaderBoardUpdating || leaderBoard === null) {
        return;//Do Nothing
    }
    //Check if the API key is setup, so Racing Skill can be gathered
    optionGetRacingSkills = (GM_getValue('apiKey') && GM_getValue('apiKey').length > 0);
    //Initiates a Mutation observer on the leaderboard, if one is not already present
    WatchLeaderBoardForChanges(leaderBoard);
    //Grabs the driver ids from the leaderboard object
    const driverIds = GetDriverIds(leaderBoard);
    //if no drivers were found, because it wasn't properly loaded yet, wait
    if (!driverIds || !driverIds.length) {
        return;//Do Nothing
    }
    //Flagging that an update to the leaderboard is underway
    leaderBoardUpdating = true;
    //Append the updating text so the user knows the script is working
    if ($('#updating').size() < 1) {
        $('#racingupdatesnew').prepend('<div id="updating" style="color: green; font-size: 12px; line-height: 24px;">Updating drivers\' RS and skins...</div>');
    }
    //Gets the racing skill of the drivers involved, if the API key is supplied
    racingSkills = optionGetRacingSkills ? await GetRacingSkillForDrivers(driverIds) : {};
    //Gets the racing skins from Brainslugs server
    const racingSkins = optionShowCustomCarSkin ? await GetSkinsForDrivers(driverIds) : {};
    //Iterate through all drivers and assign the racing skills and skins
    for (let driver of leaderBoard.querySelectorAll('ul.driver-item')) {
        //Get Unique identifier for the current driver
        const driverId = GetDriverId(driver);
        //Check if racing skills are to be appended and any was added for the driver
        if (optionGetRacingSkills && racingSkills[driverId]) {
            //Get the racing skill & name
            const skill = racingSkills[driverId];
            const nameDiv = driver.querySelector('li.name');
            nameDiv.style.position = 'relative';
            //If not already added, add the name and racing skill
            if (!driver.querySelector('span.rs-display')) {
                nameDiv.insertAdjacentHTML('beforeend', `<span class="rs-display">RS:${skill}</span>`);
            }
        //Check if racing skills were not picked
        } else if (!optionGetRacingSkills) {
            //Select any racing skills already displayed
            const rsSpan = driver.querySelector('span.rs-display');
            //Check if any is found remove them
            if (rsSpan) {
                rsSpan.remove();
            }
        }
        //Check if skins are to be shown and any was found for the driver
        if (optionShowCustomCarSkin && racingSkins[driverId]) {
            //Gets the current car image & id
            const carImg = driver.querySelector('li.car').querySelector('img');
            const carId = carImg.getAttribute('src').replace(/[^0-9]*/g, '');
            //Checks if there is a skin to be shown
            if (racingSkins[driverId][carId]) {
                //Set the skin reference to replace the normal car
                carImg.setAttribute('src', GetBrainslugsCarSkin(racingSkins[driverId][carId]));
                //Check if current user, then sidebar should be coloured too
                if (driverId == userID) {
                    //Changes the skin on the left menu if applicaple
                    ChangeCarSkinOnMenu(racingSkins[driverId][carId]);
                }
            }
        }
    }
    //Flagging that an update to the leaderboard has finished
    leaderBoardUpdating = false;
    //Remove the updating text so the user knows the script is Finished
    if ($('#updating').size() > 0) {
        $('#updating').remove();
    }
}

/**
 * Initiated a mutation observer on the leaderboard supplied
 * @param {HTMLElement} leaderBoard The leaderboard to observe for changes
 * @returns Does nothing if there's already a watcher on the leaderboard
 */
function WatchLeaderBoardForChanges(leaderBoard) {
    //Check if there is already a watcher on the leaderboards dataset
    if (leaderBoard.dataset.hasWatcher !== undefined) {
        return;//Do nothing
    }
    //Watching for changes as these come in from Torn and other functions, if a change is made, calls updateLeaderboard
    new MutationObserver(UpdateLeaderboard).observe(leaderBoard, {childList: true});
    //Note down that there is an observer watching this dataset, so it doesn't lead to stacked MutationObservers
    leaderBoard.dataset.hasWatcher = 'true';
}

/**
 * Gets all driver Id's from the leaderboard
 * @param {HTMLElement} leaderBoard The leaderboard to get drivers from
 * @returns An array of the Id's for the drivers
 */
function GetDriverIds(leaderBoard) {
    //Goes through the leaderboard looking for the ul containers 
    return Array.from(leaderBoard.querySelectorAll('ul.driver-item')).map((driver) => {
        //Gets the driver Id and adds that to the array
        return GetDriverId(driver);
    });
}

/**
 * Gets the driver id for the supplied driver ul
 * @param {HTMLElement} driverUl The Ul tag containing the drivers information
 * @returns The unique Id of the driver
 */
function GetDriverId(driverUl) {
    //Steps up and gets the parent container, which has the user Id
    return driverUl.closest('li').id.substring(4);
}

/**
 * Collects and returns all the racing skills for drivers
 * @param {string[]} driverIds Array containing the unique identifiers for the racers
 * @returns An object containing the driver Id's as attributes, with the skill as the value of that attribute
 */
async function GetRacingSkillForDrivers(driverIds) {
    //Checks which driver Id's haven't already been fetched
    const driverIdsMissingRacingSkill = driverIds.filter((driverId) => {
        //Checks if the driver is already stored in cache storage
        return !cachedRacingSkills.has(driverId);
    });
    //Iterates through the missing driver Id's
    for (let index = 0; index < driverIdsMissingRacingSkill.length; index++) {
        //Calls the Torn API to get the drivers racing skill
        const json = await GetRacingSkillFromAPI(driverIdsMissingRacingSkill[index]);

        //Check if the Racing skills is available and put that in the storage, if something went wrong note it wasn't avaiable
        cachedRacingSkills.set(driverIdsMissingRacingSkill[index], json && json.personalstats && json.personalstats.racingskill ? json.personalstats.racingskill : 'N/A');
        //Check if there was any error message 
        if (json && json.error) {
            //Display error to the user and stop
            $('#racingupdatesnew').prepend(`<div style="color: red; font-size: 12px; line-height: 24px;">API error: ${JSON.stringify(json.error)}</div>`);
            break;
        }
        //Count up racers
        index++;
        if (index % 20) {
            //For every 20 racers wait a bit to let torn cooldown
            await new Promise((resolve) => {
                setTimeout(resolve, apiWaitTime);
            });
        }
    }
    //Build result object
    const resultHash = {};
    for (const driverId of driverIds) {
        //Grabs the cached skill
        const skill = cachedRacingSkills.get(driverId);
        if (skill) {
            //Assign object attribute driverId with skill as value
            resultHash[driverId] = skill;
        }
    }
    return resultHash;
}

/**
 * Returns the supplied drivers racing skill
 * @param {string} driverId unique identifier for the driver
 * @returns JSON response object from the server on success
 */
function GetRacingSkillFromAPI(driverId) {
    //Grabs the API key from Tampermonkey storage
    const apiKey = GM_getValue('apiKey');
    return new Promise((resolve, reject) => {
        //Calls on Tampermonkey to make the HTTP request to Torn
        GM_xmlhttpRequest({
            method: 'POST',
            url: `https://api.torn.com/user/${driverId}?selections=personalstats&comment=RacingUiUx&key=${apiKey}`,
            headers: {
                'Content-Type': 'application/json'
            },
            onload: (response) => {
                //Successfully got a response
                try {
                    //Attempt to convert the response to JSON and return this to the caller
                    resolve(JSON.parse(response.responseText));
                } catch(err) {
                    //Couldn't parse it to JSON, must be an error
                    reject(err);
                }
            },
            onerror: (err) => {
                //Oh no an error has occured
                reject(err);
            }
        });
    });
}

/**
 * Gets race skils from brainslugs domain
 * @param {string[]} driverIds Array of unique Id's to check for skins
 * @returns object containing the skins available to the drivers
 */
async function GetSkinsForDrivers(driverIds) {
    return new Promise(resolve => {
        //Checks if the skins have already been collected, if so returns those
        if (_skinOwnerCache) {
            return resolve(_skinOwnerCache);
        }
        //Calls on Tampermonkey to make the HTTP request to Torn
        GM_xmlhttpRequest({
            method: 'GET',
            url: brainslugRaceSkinUrl,
            headers: {'Content-Type': 'application/json'},
            onload: ({responseText}) => {
                //Success parse the JSON and reutnr it
                _skinOwnerCache = JSON.parse(responseText);
                resolve(_skinOwnerCache);
            },
            onerror: (err) => {
                //Error occoured, this is not critical to the experience, so fail silently and return as if none was available
                console.error(err);
                resolve({});
            },
        });
    }).then((skins) => {
        //Successfully gor the skins now back them into a nice result object
        let result = {};
        for (const driverId of driverIds) {
            //Check if the driver Id is in the mixed pool
            if (skins && skins['*'] && skins['*'][driverId]) {
                result[driverId] = skins['*'][driverId];
            }
            //Check if the driver Id is in a race specific pool
            if (skins && skins[raceId] && skins[raceId][driverId]) {
                result[driverId] = skins[raceId][driverId];
            }
        }
        return result;
    });
}

/**
 * Creates the url to brainslugs car skin images
 * @param {string} skinId Unique Identifier for the skin
 * @returns image url to the car skin
 */
function GetBrainslugsCarSkin (skinId) {
    return `${brainslugSkinImageUrl}/${skinId}`;
}

/**
 * Changes the car skin on the current car in the left menu
 * @param {string} carSkin Unique identifier for the skin
 * @returns nothing, but sooner if something is missing in the left menu
 */
function ChangeCarSkinOnMenu(carSkin) {
    //Check if the current car menu is opened
    const selectedCar = document.querySelector('div.car-selected');
    if (!selectedCar) {
        return; //The menu wasn't open, do nothing
    }
    //Checks if there is an image shown
    const carImage = selectedCar.querySelector('img.torn-item');
    if (!carImage) {
        return;//No image found, do nothing
    }
    //Checks if the item is already skinned with this image
    if (carImage !== skinnedCarInMenu) {
        try {
            //It was not so replace the url and display it
            carImage.setAttribute('src', GetBrainslugsCarSkin(carSkin));
            carImage.style.display = 'block';
            carImage.style.opacity = 1;
            //Checks if a canvas is place in the menu
            const canvas = selectedCar.querySelector('canvas');
            if (canvas) {
                //Hide it so the car skin can be shown
                canvas.style.display = 'none';
            }
            //Store current selected car skin for future comparison
            skinnedCarInMenu = carImage;
        } catch (err) {
            //An error has occoured log in console, user doesn't need to know
            console.error(err);
        }
    }
}

/**
 * Creates the speed information in the information row below the map and sets an interval to calculate the current speed
 * @returns nothing, but early if the DOM is not ready to calculate or it's already at it
 */
function CreateSpeedInformationAndCalculation() {
    //Checks if the option is checked, that racing details haven't been added or that racing details already have the current speed
    if (!optionShowSpeed || $('#racingdetails').size() < 1 || $('#racingdetails').find('#speed_mph').size() > 0) {
        return;//Do nothing
    }

    //Hide and rename headings to save some space for the speed to fit into
    $('#racingdetails').find('li.pd-name').each(() => {
        if ($(this).text() == 'Name:') {
            $(this).hide();//Hide name, it's obvious anyway
        } else if ($(this).text() == 'Position:') {
            $(this).text('Pos:');//Shorten to Pos
        } else if ($(this).text() == 'Completion:') {
            $(this).text('Compl:');//Shorten to Compl
        }
    });
    //Append the speed element
    $('#racingdetails').append('<li id="speed_mph" class="pd-val"></li>');
    //Clears the speed calculations if an interval was already running
    ClearSpeedInterval();
    //Initiates new speed calculations on set interval
    currentSpeedInterval = setInterval(() => {
        //Check if the map information is loaded in otherwise wait
        if ($('#racingupdatesnew').find('div.track-info').size() < 1) {
            ClearSpeedInterval();//Remove the interval the browser is not ready
            return;
        }
        //Gets the lap count for the race
        let laps = $('#racingupdatesnew').find('div.title-black').text().split(" - ")[1].split(" ")[0];
        //Gets the length of the map
        let length = $('#racingupdatesnew').find('div.track-info').attr('data-length').replace('mi', '');
        //Gets the current percentage completed of the map
        let completedPercentage = $('#racingdetails').find('li.pd-completion').text().replace('%', '');
        //Check if the race has started, checked by seeing if the car has moved off the start line last checkup
        if (lastCompletedLap >= 0) {
            //Calculate the current speed, by figuring how much was completed since last, check it with the laps needed and the length of those laps, upped to hours, devided by how often is checked
            let speed = (completedPercentage - lastCompletedLap) / 100 * laps * length * 60 * 60 * 1000 / speedCalculationIntervalPeriod;
            $('#speed_mph').text(`${speed.toFixed(2)}mph`);
        }
        //Store new completed %'s for next calculations
        lastCompletedLap = completedPercentage;
    }, speedCalculationIntervalPeriod);
}

/**
 * Clears the current running speed calculations interval if set
 */
function ClearSpeedInterval() {
    if (currentSpeedInterval != 0 ) {
        clearInterval(currentSpeedInterval);
        lastCompletedLap = -1.0;
        currentSpeedInterval = 0;
    }
}

/**
 * Checks if there's a penalty on the user and they cannot join an official race right now
 */
function CheckForPenaltyAndDisplayTime() {
    //Checks if you have a penalty for leaving an official race resently
    if ($('#racingAdditionalContainer').find('div.msg.right-round').size() > 0 && $('#racingAdditionalContainer').find('div.msg.right-round').text().trim().startsWith('You have recently left')) {
        //Checks how much time remains
        const penaltyTime = GM_getValue('leavepenalty') * 1000;
        const currentDateTime = Date.now();
        if (penaltyTime > currentDateTime) {
            //Display when the user is able to join a new official race
            const date = new Date(penaltyTime);
            $('#racingAdditionalContainer').find('div.msg.right-round').text(`You may join an official race at ${formatTime(date)}.`);
        }
    }
}
